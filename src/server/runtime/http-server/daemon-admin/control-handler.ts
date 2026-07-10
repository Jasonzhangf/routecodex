import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../../../constants/index.js';
import { decodeUserConfigFile } from '../../../../config/user-config-codec.js';
import { writeUserConfigFile } from '../../../../config/user-config-writer.js';
import { listManagedServerPidsByPort } from '../../../../utils/managed-server-pids.js';
import { loadPolicyFromConfigPath, writePolicyToConfigPath } from './routing-policy.js';
import {
  activateRoutingGroupAtLocation,
  extractRoutingGroupsSnapshot,
  extractRoutingSnapshot
} from './providers-handler-routing-utils.js';
import {
  getServerToolRuntimeState,
  readServerToolStatsSnapshot,
  setServerToolEnabled
} from '../servertool-admin-state.js';
import { resolveRccSessionsDir } from '../../../../config/user-data-paths.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';

type ControlServerInfo = {
  host: string;
  port: number;
  serverId?: string | null;
  version?: string | null;
  ready?: boolean | null;
  pids?: number[];
};

type ControlSnapshot = {
  nowMs: number;
  controlServer: { serverId: string };
  servers: ControlServerInfo[];
  serverTool?: {
    state: ReturnType<typeof getServerToolRuntimeState>;
    stats: ReturnType<typeof readServerToolStatsSnapshot>;
  };
  routing?: {
    virtualRouterConfig?: unknown;
    policy?: unknown;
    policyHash?: string | null;
  };
  stats?: unknown;
  llmsStats?: unknown;
};


function logControlNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[daemon-control] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function getSessionCandidatePorts(): number[] {
  const base = resolveRccSessionsDir();
  try {
    if (!fs.existsSync(base)) {
      return [];
    }
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const ports: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const name = entry.name;
      const m = name.match(/_(\d+)$/);
      if (!m) {
        continue;
      }
      const port = Number(m[1]);
      if (Number.isFinite(port) && port > 0) {
        ports.push(port);
      }
    }
    return ports;
  } catch (error) {
    logControlNonBlockingError('getSessionCandidatePorts', error, { base });
    return [];
  }
}

async function fetchHealthQuick(port: number): Promise<{ ok: boolean; version?: string; ready?: boolean }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => {
      try {
        controller.abort();
      } catch (error) {
        logControlNonBlockingError('fetchHealthQuick.abort', error, { port });
      }
    }, 900);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.HEALTH}`, {
      method: 'GET',
      signal: controller.signal
    }).catch((error) => {
      logControlNonBlockingError('fetchHealthQuick.fetch', error, { port });
      return null;
    });
    clearTimeout(t);
    if (!res || !res.ok) {
      return { ok: false };
    }
    const data = await (res as any).json?.().catch((error: unknown) => {
      logControlNonBlockingError('fetchHealthQuick.json', error, { port });
      return null;
    });
    if (!data || typeof data !== 'object' || (data as any).server !== 'routecodex') {
      return { ok: false };
    }
    const version = typeof (data as any).version === 'string' ? String((data as any).version) : undefined;
    const ready = typeof (data as any).ready === 'boolean' ? Boolean((data as any).ready) : undefined;
    return { ok: true, version, ready };
  } catch (error) {
    logControlNonBlockingError('fetchHealthQuick', error, { port });
    return { ok: false };
  }
}

function listLocalServers(options: { includePorts?: number[]; includeDevDefault?: boolean }): number[] {
  const ports = new Set<number>();
  for (const p of getSessionCandidatePorts()) {
    ports.add(p);
  }
  const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
  if (Number.isFinite(envPort) && envPort > 0) {
    ports.add(envPort);
  }
  if (options.includeDevDefault !== false) {
    ports.add(5555);
  }
  for (const p of options.includePorts ?? []) {
    if (Number.isFinite(p) && p > 0) {
      ports.add(p);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

function findPidsByPort(port: number): number[] {
  return listManagedServerPidsByPort(port, { processKill: process.kill.bind(process) });
}

async function discoverServers(): Promise<ControlServerInfo[]> {
  const candidates = listLocalServers({ includeDevDefault: true });
  const out: ControlServerInfo[] = [];
  for (const port of candidates) {
    const health = await fetchHealthQuick(port);
    if (!health.ok) {
      continue;
    }
    const pids = findPidsByPort(port);
    out.push({
      host: LOCAL_HOSTS.LOCALHOST,
      port,
      serverId: `${LOCAL_HOSTS.LOCALHOST}:${port}`,
      version: health.version ?? null,
      ready: health.ready ?? null,
      pids
    });
  }
  return out;
}

function mapRoutingGroupErrorToStatus(error: unknown): number {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'group_not_found') {
    return 404;
  }
  if (code === 'group_in_use' || code === 'group_last_one') {
    return 409;
  }
  if (code === 'invalid_group_id' || code === 'invalid_policy') {
    return 400;
  }
  return 500;
}

async function broadcastRestartToOtherServers(selfId: string): Promise<void> {
  const servers = await discoverServers();
  for (const t of servers) {
    const sid = `${LOCAL_HOSTS.LOCALHOST}:${t.port}`;
    if (sid === selfId) {
      continue;
    }
    const pids = Array.isArray(t.pids) ? t.pids : findPidsByPort(t.port);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGUSR2');
      } catch (error) {
        logControlNonBlockingError('broadcastRestartToOtherServers.kill', error, { pid, port: t.port });
      }
    }
  }
}

async function activateRoutingGroupAtConfigPath(options: {
  configPath: string;
  groupId: string;
}): Promise<{ activeGroupId: string; wroteAtMs: number }> {
  const decoded = await decodeUserConfigFile(options.configPath);
  const root = decoded.parsed && typeof decoded.parsed === 'object' && !Array.isArray(decoded.parsed)
    ? (decoded.parsed as Record<string, unknown>)
    : {};
  const detected = extractRoutingSnapshot(root);
  const nextConfig = activateRoutingGroupAtLocation(root, options.groupId, detected.location);
  const groupsSnapshot = extractRoutingGroupsSnapshot(nextConfig, detected.location);

  const wroteAtMs = Date.now();
  await writeUserConfigFile(options.configPath, nextConfig);

  return {
    activeGroupId: groupsSnapshot.activeGroupId,
    wroteAtMs
  };
}


export function registerControlRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/control/snapshot', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const nowMs = Date.now();
    const servers = await discoverServers();

    let vrConfig: unknown = null;
    try {
      const artifacts = typeof options.getVirtualRouterArtifacts === 'function' ? options.getVirtualRouterArtifacts() : null;
      vrConfig = artifacts && typeof artifacts === 'object' ? (artifacts as any).config ?? null : null;
    } catch (error) {
      logControlNonBlockingError('snapshot.virtualRouterConfig', error);
      vrConfig = null;
    }

    const configPath = typeof options.getConfigPath === 'function' ? options.getConfigPath() : null;
    const { policy, policyHash } = await loadPolicyFromConfigPath(configPath);

    const snapshot: ControlSnapshot = {
      nowMs,
      controlServer: { serverId: options.getServerId() },
      servers,
      serverTool: {
        state: getServerToolRuntimeState(),
        stats: readServerToolStatsSnapshot()
      },
      routing: {
        virtualRouterConfig: vrConfig,
        policy,
        policyHash
      },
      stats: typeof options.getStatsSnapshot === 'function' ? options.getStatsSnapshot() : undefined
    };
    res.status(200).json(snapshot);
  });

  app.post('/daemon/control/mutate', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const body = (req.body && typeof req.body === 'object') ? (req.body as any) : {};
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const nowMs = Date.now();

    if (action === 'routing.policy.set') {
      const configPath = typeof options.getConfigPath === 'function' ? options.getConfigPath() : null;
      if (!configPath) {
        res.status(503).json({ error: { message: 'configPath not available', code: 'not_ready' } });
        return;
      }
      const policy = body.policy;
      try {
        const writeResult = await writePolicyToConfigPath({ configPath, policy });
        // Apply policy locally without cutting the HTTP response.
        let selfReload: unknown = null;
        try {
          if (typeof options.restartRuntimeFromDisk === 'function') {
            selfReload = await options.restartRuntimeFromDisk();
          }
        } catch (e: any) {
          selfReload = { ok: false, message: e?.message || 'self reload failed' };
        }
        // Best-effort: ask other servers to restart to pick up the new config from disk.
        try {
          await broadcastRestartToOtherServers(options.getServerId());
        } catch (error) {
          logControlNonBlockingError('routing.policy.set.broadcastRestart', error, {
            serverId: options.getServerId()
          });
        }
        res.status(200).json({
          ok: true,
          action,
          nowMs,
          configPath,
          policyHash: writeResult.policyHash,
          wroteAtMs: writeResult.wroteAtMs,
          selfReload,
          schema: 'v2',
          updatedVia: 'unified_control'
        });
      } catch (e: any) {
        res.status(400).json({ error: { message: e?.message || 'invalid policy', code: 'bad_request' } });
      }
      return;
    }

    if (action === 'routing.group.activate') {
      const configPath = typeof options.getConfigPath === 'function' ? options.getConfigPath() : null;
      if (!configPath) {
        res.status(503).json({ error: { message: 'configPath not available', code: 'not_ready' } });
        return;
      }
      const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
      if (!groupId) {
        res.status(400).json({ error: { message: 'groupId is required', code: 'bad_request' } });
        return;
      }
      const restartScope = body.restartScope === 'all' ? 'all' : 'self';

      try {
        const writeResult = await activateRoutingGroupAtConfigPath({ configPath, groupId });

        let selfReload: unknown = null;
        try {
          if (typeof options.restartRuntimeFromDisk === 'function') {
            selfReload = await options.restartRuntimeFromDisk();
          }
        } catch (e: any) {
          selfReload = { ok: false, message: e?.message || 'self reload failed' };
        }

        if (restartScope === 'all') {
          try {
            await broadcastRestartToOtherServers(options.getServerId());
          } catch (error) {
            logControlNonBlockingError('routing.group.activate.broadcastRestart', error, {
              serverId: options.getServerId(),
              restartScope
            });
          }
        }

        const { policyHash } = await loadPolicyFromConfigPath(configPath);
        res.status(200).json({
          ok: true,
          action,
          nowMs,
          configPath,
          activeGroupId: writeResult.activeGroupId,
          restartScope,
          policyHash,
          wroteAtMs: writeResult.wroteAtMs,
          selfReload,
          schema: 'v2',
          updatedVia: 'unified_control'
        });
      } catch (error: unknown) {
        const status = mapRoutingGroupErrorToStatus(error);
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string } | null)?.code;
        res.status(status).json({ error: { message, code: status === 500 ? 'internal_error' : code || 'bad_request' } });
      }
      return;
    }

    if (action === 'servers.restart') {
      const portsRaw = Array.isArray(body.ports) ? body.ports : null;
      const explicitPorts =
        portsRaw ? portsRaw.map((p: any) => Number(p)).filter((n: number) => Number.isFinite(n) && n > 0) : [];
      const servers = await discoverServers();
      const targets = explicitPorts.length ? servers.filter((s) => explicitPorts.includes(s.port)) : servers;
      const selfId = options.getServerId();

      const results: Array<{ port: number; pids: number[]; signal: string; ok: boolean; note?: string }> = [];
      // Restart other servers via signal first.
      for (const t of targets) {
        const sid = `${LOCAL_HOSTS.LOCALHOST}:${t.port}`;
        if (sid === selfId) {
          continue;
        }
        const pids = Array.isArray(t.pids) ? t.pids : findPidsByPort(t.port);
        let ok = false;
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGUSR2');
            ok = true;
          } catch (error) {
            logControlNonBlockingError('servers.restart.kill', error, { pid, port: t.port });
          }
        }
        results.push({ port: t.port, pids, signal: 'SIGUSR2', ok });
      }

      // Self: prefer in-process reload to avoid cutting the control response.
      if (targets.some((t) => `${LOCAL_HOSTS.LOCALHOST}:${t.port}` === selfId)) {
        try {
          if (typeof options.restartRuntimeFromDisk === 'function') {
            await options.restartRuntimeFromDisk();
            results.push({ port: Number(selfId.split(':').pop() || 0), pids: [], signal: 'runtime.reload', ok: true, note: 'self reload' });
          } else {
            const selfPort = Number(selfId.split(':').pop() || 0);
            const pids = selfPort ? findPidsByPort(selfPort) : [];
            let ok = false;
            for (const pid of pids) {
              try {
                process.kill(pid, 'SIGUSR2');
                ok = true;
              } catch (error) {
                logControlNonBlockingError('servers.restart.self.kill', error, { pid, port: selfPort });
              }
            }
            results.push({ port: selfPort, pids, signal: 'SIGUSR2', ok, note: 'self signal' });
          }
        } catch (e: any) {
          results.push({ port: Number(selfId.split(':').pop() || 0), pids: [], signal: 'runtime.reload', ok: false, note: e?.message || 'self reload failed' });
        }
      }

      res.status(200).json({ ok: true, action, nowMs, results, schema: 'v2', updatedVia: 'unified_control' });
      return;
    }

    if (action === 'servertool.set_enabled') {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: { message: 'enabled(boolean) is required', code: 'bad_request' } });
        return;
      }
      const state = setServerToolEnabled(body.enabled, 'daemon-admin.control');
      res.status(200).json({
        ok: true,
        action,
        nowMs,
        state,
        schema: 'v2',
        updatedVia: 'unified_control'
      });
      return;
    }

    if (action === 'runtime.restart') {
      if (typeof options.restartRuntimeFromDisk !== 'function') {
        res.status(501).json({ error: { message: 'restart endpoint not available', code: 'not_implemented' } });
        return;
      }
      const result = await options.restartRuntimeFromDisk();
      res.status(200).json({ ok: true, action, nowMs, result, schema: 'v2', updatedVia: 'unified_control' });
      return;
    }

    res.status(400).json({ error: { message: `unknown action: ${action}`, code: 'bad_request' } });
  });
}
