import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

import { API_PATHS, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../../../constants/index.js';
import { listManagedServerPidsByPort } from '../../../../utils/managed-server-pids.js';
import * as llmsBridge from '../../../../modules/llmswitch/bridge.js';
import { loadPolicyFromConfigPath, writePolicyToConfigPath } from './routing-policy.js';
import { x7eGate, getGateState } from './routecodex-x7e-gate.js';
import { createQuotaManagerAdapter } from '../../../../manager/modules/quota/quota-adapter.js';
import {
  getServerToolRuntimeState,
  readServerToolStatsSnapshot,
  setServerToolEnabled
} from '../servertool-admin-state.js';

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
  quota?: {
    providers?: unknown[];
    antigravitySnapshot?: unknown;
    updatedAtMs: number;
  };
  routing?: {
    virtualRouterConfig?: unknown;
    policy?: unknown;
    policyHash?: string | null;
    antigravityAliasLeases?: unknown;
  };
  stats?: unknown;
  llmsStats?: unknown;
  x7e?: {
    gate: Record<string, boolean | string>;
    phase0ApiCompatible: boolean;
  };
};

function getSessionCandidatePorts(): number[] {
  const base = path.join(homedir(), '.routecodex', 'sessions');
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
  } catch {
    return [];
  }
}

async function fetchHealthQuick(port: number): Promise<{ ok: boolean; version?: string; ready?: boolean }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, 900);
    const res = await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${port}${API_PATHS.HEALTH}`, {
      method: 'GET',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) {
      return { ok: false };
    }
    const data = await (res as any).json?.().catch(() => null);
    if (!data || typeof data !== 'object' || (data as any).server !== 'routecodex') {
      return { ok: false };
    }
    const version = typeof (data as any).version === 'string' ? String((data as any).version) : undefined;
    const ready = typeof (data as any).ready === 'boolean' ? Boolean((data as any).ready) : undefined;
    return { ok: true, version, ready };
  } catch {
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

function getQuotaModule(options: DaemonAdminRouteOptions): any | null {
  const daemon = options.getManagerDaemon() as { getModule?: (id: string) => any } | null;
  if (!daemon || typeof daemon.getModule !== 'function') {
    return null;
  }
  return daemon.getModule('quota') ?? null;
}

function getQuotaAdapter(options: DaemonAdminRouteOptions): any | null {
  const daemon = options.getManagerDaemon() as { getModule?: (id: string) => any } | null;
  if (!daemon || typeof daemon.getModule !== 'function') {
    return null;
  }
  const quotaModule = daemon.getModule('quota') ?? null;
  if (!quotaModule) {
    return null;
  }
  const providerQuotaModule = daemon.getModule('provider-quota') ?? null;
  const coreLike = typeof quotaModule.getCoreQuotaManager === 'function' ? quotaModule.getCoreQuotaManager() : null;
  return createQuotaManagerAdapter({
    coreManager: coreLike,
    legacyDaemon: providerQuotaModule,
    quotaRoutingEnabled: true
  });
}



export function registerControlRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/control/snapshot', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const nowMs = Date.now();
    const servers = await discoverServers();

    const quotaMod = getQuotaModule(options);
    let quotaProviders: unknown[] | undefined = undefined;
    let antigravitySnapshot: unknown = undefined;
    try {
      const adminSnapshot = typeof quotaMod?.getAdminSnapshot === 'function' ? quotaMod.getAdminSnapshot() : null;
      if (adminSnapshot && typeof adminSnapshot === 'object') {
        quotaProviders = Object.values(adminSnapshot).map((state: any) => ({
          providerKey: state?.providerKey ?? null,
          inPool: Boolean(state?.inPool),
          reason: state?.reason ?? null,
          authIssue: state?.authIssue ?? null,
          authType: state?.authType ?? null,
          priorityTier: typeof state?.priorityTier === 'number' ? state.priorityTier : null,
          cooldownUntil: state?.cooldownUntil ?? null,
          blacklistUntil: state?.blacklistUntil ?? null,
          consecutiveErrorCount: typeof state?.consecutiveErrorCount === 'number' ? state.consecutiveErrorCount : 0,
          ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {})
        }));
      }
    } catch {
      quotaProviders = undefined;
    }
    try {
      antigravitySnapshot = typeof quotaMod?.getRawSnapshot === 'function' ? quotaMod.getRawSnapshot() : undefined;
    } catch {
      antigravitySnapshot = undefined;
    }

    let vrConfig: unknown = null;
    try {
      const artifacts = typeof options.getVirtualRouterArtifacts === 'function' ? options.getVirtualRouterArtifacts() : null;
      vrConfig = artifacts && typeof artifacts === 'object' ? (artifacts as any).config ?? null : null;
    } catch {
      vrConfig = null;
    }

    const configPath = typeof options.getConfigPath === 'function' ? options.getConfigPath() : null;
    const { policy, policyHash } = await loadPolicyFromConfigPath(configPath);

    let antigravityAliasLeases: unknown = null;
    try {
      const leasePath = path.join(homedir(), '.routecodex', 'state', 'antigravity-alias-leases.json');
      if (fs.existsSync(leasePath)) {
        const raw = fs.readFileSync(leasePath, 'utf8');
        antigravityAliasLeases = raw && raw.trim() ? JSON.parse(raw) : null;
      }
    } catch {
      antigravityAliasLeases = null;
    }

    const snapshot: ControlSnapshot = {
      nowMs,
      controlServer: { serverId: options.getServerId() },
      servers,
      serverTool: {
        state: getServerToolRuntimeState(),
        stats: readServerToolStatsSnapshot()
      },
      quota: {
        providers: quotaProviders,
        antigravitySnapshot,
        updatedAtMs: nowMs,
        ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {})
      },
      routing: {
        virtualRouterConfig: vrConfig,
        policy,
        policyHash,
        antigravityAliasLeases
      },
      stats: typeof options.getStatsSnapshot === 'function' ? options.getStatsSnapshot() : undefined,
      llmsStats: llmsBridge.getLlmsStatsSnapshot?.() ?? undefined,
      x7e: {
        gate: getGateState(),
        phase0ApiCompatible: true
      }
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
          const servers = await discoverServers();
          const selfId = options.getServerId();
          for (const t of servers) {
            const sid = `${LOCAL_HOSTS.LOCALHOST}:${t.port}`;
            if (sid === selfId) {
              continue;
            }
            const pids = Array.isArray(t.pids) ? t.pids : findPidsByPort(t.port);
            for (const pid of pids) {
              try { process.kill(pid, 'SIGUSR2'); } catch { /* ignore */ }
            }
          }
        } catch {
          // ignore broadcast errors
        }
        res.status(200).json({
          ok: true,
          action,
          nowMs,
          configPath,
          policyHash: writeResult.policyHash,
          wroteAtMs: writeResult.wroteAtMs,
          selfReload,
          ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {})
        });
      } catch (e: any) {
        res.status(400).json({ error: { message: e?.message || 'invalid policy', code: 'bad_request' } });
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
          } catch {
            // ignore
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
              try { process.kill(pid, 'SIGUSR2'); ok = true; } catch { /* ignore */ }
            }
            results.push({ port: selfPort, pids, signal: 'SIGUSR2', ok, note: 'self signal' });
          }
        } catch (e: any) {
          results.push({ port: Number(selfId.split(':').pop() || 0), pids: [], signal: 'runtime.reload', ok: false, note: e?.message || 'self reload failed' });
        }
      }

      res.status(200).json({ ok: true, action, nowMs, results, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
      return;
    }

    if (action === 'quota.disable') {
      const providerKey = typeof body.providerKey === 'string' ? body.providerKey.trim() : '';
      const mode = body.mode === 'blacklist' ? 'blacklist' : 'cooldown';
      const durationMs = typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) ? Math.floor(body.durationMs) : 0;
      if (!providerKey || !durationMs) {
        res.status(400).json({ error: { message: 'providerKey and durationMs are required', code: 'bad_request' } });
        return;
      }
      const quotaMod = getQuotaAdapter(options);
      if (!quotaMod || typeof quotaMod.disableProvider !== 'function') {
        res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
        return;
      }
      const result = await quotaMod.disableProvider({ providerKey, mode, durationMs });
      res.status(200).json({ ok: true, action, nowMs, result, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
      return;
    }

    if (action === 'quota.recover') {
      const providerKey = typeof body.providerKey === 'string' ? body.providerKey.trim() : '';
      if (!providerKey) {
        res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
        return;
      }
      const quotaMod = getQuotaAdapter(options);
      if (!quotaMod || typeof quotaMod.recoverProvider !== 'function') {
        res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
        return;
      }
      const result = await quotaMod.recoverProvider(providerKey);
      res.status(200).json({ ok: true, action, nowMs, result, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
      return;
    }

    if (action === 'quota.reset') {
      const providerKey = typeof body.providerKey === 'string' ? body.providerKey.trim() : '';
      if (!providerKey) {
        res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
        return;
      }
      const quotaMod = getQuotaAdapter(options);
      if (!quotaMod || typeof quotaMod.resetProvider !== 'function') {
        res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
        return;
      }
      const result = await quotaMod.resetProvider(providerKey);
      res.status(200).json({ ok: true, action, nowMs, result, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
      return;
    }

    if (action === 'quota.refresh') {
      const quotaMod = getQuotaAdapter(options);
      if (!quotaMod || typeof quotaMod.refreshNow !== 'function') {
        res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
        return;
      }
      const result = await quotaMod.refreshNow();
      res.status(200).json({ ok: true, action, nowMs, result, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
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
        ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {})
      });
      return;
    }

    if (action === 'runtime.restart') {
      if (typeof options.restartRuntimeFromDisk !== 'function') {
        res.status(501).json({ error: { message: 'restart endpoint not available', code: 'not_implemented' } });
        return;
      }
      const result = await options.restartRuntimeFromDisk();
      res.status(200).json({ ok: true, action, nowMs, result, ...(x7eGate.phase2UnifiedControl ? { schema: 'v2', updatedVia: 'unified_control' } : {}) });
      return;
    }

    res.status(400).json({ error: { message: `unknown action: ${action}`, code: 'bad_request' } });
  });
}
