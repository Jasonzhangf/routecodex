import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadHeartbeatStateSnapshot,
  setHeartbeatRuntimeHooksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getSessionClientRegistry, injectSessionClientPromptWithResult } from './session-client-registry.js';
import { isTmuxSessionAlive, resolveTmuxSessionWorkingDirectory } from './tmux-session-probe.js';

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseHeartbeatUntilFromText(text: string): number | undefined {
  const match = text.match(/^\s*Heartbeat-Until:\s*(.+?)\s*$/im);
  if (!match) {
    return undefined;
  }
  const parsed = Date.parse(match[1].trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

async function readHeartbeatContext(workdir: string): Promise<{
  heartbeatFile: string;
  heartbeatUntilMs?: number;
}> {
  const heartbeatFile = path.join(workdir, 'HEARTBEAT.md');
  const raw = await fs.readFile(heartbeatFile, 'utf8');
  return {
    heartbeatFile,
    heartbeatUntilMs: parseHeartbeatUntilFromText(raw)
  };
}

function shouldDisableForInjectFailure(reasonRaw: unknown): boolean {
  const reason = String(reasonRaw || '').trim().toLowerCase();
  if (!reason) {
    return false;
  }
  return (
    reason === 'tmux_session_required' ||
    reason === 'tmux_session_not_found' ||
    reason.startsWith('tmux_send_failed')
  );
}

export async function dispatchSingleHeartbeat(args: {
  tmuxSessionId: string;
  injectText: string;
  requestActivityTracker: { countActiveRequestsForTmuxSession(tmuxSessionId: string): number };
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const tmuxSessionId = readString(args.tmuxSessionId);
  if (!tmuxSessionId) {
    return { ok: false, skipped: true, reason: 'tmux_session_required' };
  }
  if (!isTmuxSessionAlive(tmuxSessionId)) {
    return { ok: false, disable: true, reason: 'tmux_session_not_found' };
  }

  const activeRequests = args.requestActivityTracker.countActiveRequestsForTmuxSession(tmuxSessionId);
  if (activeRequests > 0) {
    return { ok: false, skipped: true, reason: 'request_inflight', activeRequests };
  }

  const registry = getSessionClientRegistry();
  if (registry.hasAliveTmuxSession(tmuxSessionId)) {
    return { ok: false, skipped: true, reason: 'client_connected' };
  }

  const workdir = resolveTmuxSessionWorkingDirectory(tmuxSessionId);
  if (!workdir) {
    return { ok: false, skipped: true, reason: 'tmux_workdir_missing' };
  }

  let heartbeatContext: { heartbeatFile: string; heartbeatUntilMs?: number };
  try {
    heartbeatContext = await readHeartbeatContext(workdir);
  } catch {
    return { ok: false, disable: true, reason: 'heartbeat_file_missing', workdir };
  }

  const nowMs = Date.now();
  if (
    typeof heartbeatContext.heartbeatUntilMs === 'number' &&
    Number.isFinite(heartbeatContext.heartbeatUntilMs) &&
    heartbeatContext.heartbeatUntilMs <= nowMs
  ) {
    return {
      ok: false,
      disable: true,
      reason: 'heartbeat_until_expired',
      workdir,
      heartbeatUntilMs: heartbeatContext.heartbeatUntilMs
    };
  }

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      workdir,
      heartbeatFile: heartbeatContext.heartbeatFile,
      ...(typeof heartbeatContext.heartbeatUntilMs === 'number'
        ? { heartbeatUntilMs: heartbeatContext.heartbeatUntilMs }
        : {})
    };
  }

  const injectResult = await injectSessionClientPromptWithResult({
    tmuxSessionId,
    sessionId: tmuxSessionId,
    tmuxOnly: true,
    text: args.injectText,
    workdir,
    requestId: `heartbeat:${tmuxSessionId}:${nowMs}`,
    source: 'heartbeat_daemon'
  });

  if (injectResult.ok) {
    return {
      ok: true,
      workdir,
      heartbeatFile: heartbeatContext.heartbeatFile,
      ...(typeof heartbeatContext.heartbeatUntilMs === 'number'
        ? { heartbeatUntilMs: heartbeatContext.heartbeatUntilMs }
        : {})
    };
  }

  const reason = readString(injectResult.reason) || 'inject_failed';
  return {
    ok: false,
    ...(shouldDisableForInjectFailure(reason) ? { disable: true } : {}),
    reason,
    workdir
  };
}

export async function triggerHeartbeatNow(args: {
  tmuxSessionId: string;
  requestActivityTracker: { countActiveRequestsForTmuxSession(tmuxSessionId: string): number };
  injectText: string;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  return dispatchSingleHeartbeat(args);
}

export async function registerHeartbeatRuntimeHooks(server: {
  requestActivityTracker: { countActiveRequestsForTmuxSession(tmuxSessionId: string): number };
}): Promise<void> {
  await setHeartbeatRuntimeHooksSnapshot({
    isTmuxSessionAlive: (tmuxSessionId: string) => {
      const normalized = readString(tmuxSessionId);
      return normalized ? isTmuxSessionAlive(normalized) : false;
    },
    dispatchHeartbeat: async (request) => {
      const result = await dispatchSingleHeartbeat({
        tmuxSessionId: readString(request?.tmuxSessionId) || '',
        injectText: readString(request?.injectText) || '',
        requestActivityTracker: server.requestActivityTracker
      });
      return result as {
        ok: boolean;
        skipped?: boolean;
        disable?: boolean;
        reason?: string;
      };
    }
  });
}

export async function clearHeartbeatRuntimeHooks(): Promise<void> {
  await setHeartbeatRuntimeHooksSnapshot(undefined);
}

export async function getHeartbeatStateForTmuxSession(tmuxSessionId: string): Promise<unknown | null> {
  return loadHeartbeatStateSnapshot(tmuxSessionId);
}
