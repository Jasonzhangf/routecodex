import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadHeartbeatStateSnapshot,
  setHeartbeatRuntimeHooksSnapshot
} from '../../../modules/llmswitch/bridge.js';
import { getSessionClientRegistry, injectSessionClientPromptWithResult } from './session-client-registry.js';
import { appendTmuxInjectionHistoryEvent } from './tmux-injection-history.js';
import {
  isTmuxSessionAlive,
  isTmuxSessionIdleForInject,
  resolveTmuxSessionWorkingDirectory
} from './tmux-session-probe.js';
import { getSessionExecutionStateTracker } from './session-execution-state.js';

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

function parseHeartbeatStopWhenFromText(text: string): 'no-open-tasks' | 'never' | undefined {
  const match = text.match(/^\s*Heartbeat-Stop-When:\s*(.+?)\s*$/im);
  if (!match) {
    return undefined;
  }
  const normalized = String(match[1] || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'no-open-tasks' || normalized === 'no_open_tasks') {
    return 'no-open-tasks';
  }
  if (normalized === 'never' || normalized === 'off' || normalized === 'disabled') {
    return 'never';
  }
  return undefined;
}

function countHeartbeatChecklistTasks(text: string): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  let inCodeFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (/^\s*[-*+]\s*\[\s\]\s+/.test(line)) {
      open += 1;
      continue;
    }
    if (/^\s*[-*+]\s*\[[xX]\]\s+/.test(line)) {
      closed += 1;
      continue;
    }
  }
  return { open, closed };
}

async function readHeartbeatContext(workdir: string): Promise<{
  heartbeatFile: string;
  heartbeatUntilMs?: number;
  heartbeatStopWhen?: 'no-open-tasks' | 'never';
  checklistOpenCount: number;
  checklistTotalCount: number;
}> {
  const heartbeatFile = path.join(workdir, 'HEARTBEAT.md');
  const raw = await fs.readFile(heartbeatFile, 'utf8');
  const checklist = countHeartbeatChecklistTasks(raw);
  return {
    heartbeatFile,
    heartbeatUntilMs: parseHeartbeatUntilFromText(raw),
    heartbeatStopWhen: parseHeartbeatStopWhenFromText(raw),
    checklistOpenCount: checklist.open,
    checklistTotalCount: checklist.open + checklist.closed
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
  const finalize = (outcome: 'triggered' | 'skipped' | 'failed' | 'disabled', payload: Record<string, unknown>): Record<string, unknown> => {
    void appendTmuxInjectionHistoryEvent({
      source: 'heartbeat',
      outcome,
      tmuxSessionId: readString(payload.tmuxSessionId) || readString(args.tmuxSessionId),
      sessionId: readString(payload.tmuxSessionId) || readString(args.tmuxSessionId),
      reason: readString(payload.reason),
      requestId: readString(payload.requestId)
    });
    return payload;
  };

  const tmuxSessionId = readString(args.tmuxSessionId);
  if (!tmuxSessionId) {
    return finalize('failed', { ok: false, skipped: true, reason: 'tmux_session_required' });
  }
  if (!isTmuxSessionAlive(tmuxSessionId)) {
    return finalize('disabled', { ok: false, disable: true, reason: 'tmux_session_not_found', tmuxSessionId });
  }

  const activeRequests = args.requestActivityTracker.countActiveRequestsForTmuxSession(tmuxSessionId);
  if (activeRequests > 0) {
    return finalize('skipped', { ok: false, skipped: true, reason: 'request_inflight', activeRequests, tmuxSessionId });
  }

  const executionState = getSessionExecutionStateTracker().getStateSnapshot(tmuxSessionId);
  if (executionState.shouldSkipHeartbeat) {
    return finalize('skipped', {
      ok: false,
      skipped: true,
      reason: 'session_execution_active',
      state: executionState.state,
      activityReason: executionState.reason,
      tmuxSessionId
    });
  }

  const registry = getSessionClientRegistry();
  if (registry.hasAliveTmuxSession(tmuxSessionId) && executionState.state === 'UNKNOWN') {
    return finalize('skipped', {
      ok: false,
      skipped: true,
      reason: 'client_connected_unknown_state',
      tmuxSessionId
    });
  }

  const injectIdle = isTmuxSessionIdleForInject(tmuxSessionId);
  if (injectIdle === false) {
    return finalize('skipped', { ok: false, skipped: true, reason: 'tmux_session_active', tmuxSessionId });
  }

  const workdir = resolveTmuxSessionWorkingDirectory(tmuxSessionId);
  if (!workdir) {
    return finalize('skipped', { ok: false, skipped: true, reason: 'tmux_workdir_missing', tmuxSessionId });
  }

  let heartbeatContext: {
    heartbeatFile: string;
    heartbeatUntilMs?: number;
    heartbeatStopWhen?: 'no-open-tasks' | 'never';
    checklistOpenCount: number;
    checklistTotalCount: number;
  };
  try {
    heartbeatContext = await readHeartbeatContext(workdir);
  } catch {
    return finalize('disabled', { ok: false, disable: true, reason: 'heartbeat_file_missing', workdir, tmuxSessionId });
  }

  const nowMs = Date.now();
  if (
    typeof heartbeatContext.heartbeatUntilMs === 'number' &&
    Number.isFinite(heartbeatContext.heartbeatUntilMs) &&
    heartbeatContext.heartbeatUntilMs <= nowMs
  ) {
    return finalize('disabled', {
      ok: false,
      disable: true,
      reason: 'heartbeat_until_expired',
      workdir,
      heartbeatUntilMs: heartbeatContext.heartbeatUntilMs,
      tmuxSessionId
    });
  }

  if (heartbeatContext.heartbeatStopWhen === 'no-open-tasks') {
    if (heartbeatContext.checklistTotalCount < 1) {
      return finalize('disabled', {
        ok: false,
        disable: true,
        reason: 'heartbeat_no_tasks',
        workdir,
        tmuxSessionId,
        heartbeatFile: heartbeatContext.heartbeatFile
      });
    }
    if (heartbeatContext.checklistOpenCount < 1) {
      return finalize('disabled', {
        ok: false,
        disable: true,
        reason: 'heartbeat_all_tasks_completed',
        workdir,
        tmuxSessionId,
        heartbeatFile: heartbeatContext.heartbeatFile
      });
    }
  }

  if (args.dryRun) {
    return finalize('triggered', {
      ok: true,
      dryRun: true,
      workdir,
      tmuxSessionId,
      heartbeatFile: heartbeatContext.heartbeatFile,
      ...(typeof heartbeatContext.heartbeatUntilMs === 'number'
        ? { heartbeatUntilMs: heartbeatContext.heartbeatUntilMs }
        : {})
    });
  }

  const heartbeatRequestId = `heartbeat:${tmuxSessionId}:${nowMs}`;
  const injectResult = await injectSessionClientPromptWithResult({
    tmuxSessionId,
    sessionId: tmuxSessionId,
    tmuxOnly: true,
    text: args.injectText,
    workdir,
    requestId: heartbeatRequestId,
    source: 'heartbeat_daemon'
  });

  if (injectResult.ok) {
    return finalize('triggered', {
      ok: true,
      workdir,
      tmuxSessionId,
      requestId: heartbeatRequestId,
      heartbeatFile: heartbeatContext.heartbeatFile,
      ...(typeof heartbeatContext.heartbeatUntilMs === 'number'
        ? { heartbeatUntilMs: heartbeatContext.heartbeatUntilMs }
        : {})
    });
  }

  const reason = readString(injectResult.reason) || 'inject_failed';
  return finalize(shouldDisableForInjectFailure(reason) ? 'disabled' : 'failed', {
    ok: false,
    ...(shouldDisableForInjectFailure(reason) ? { disable: true } : {}),
    reason,
    workdir,
    tmuxSessionId,
    requestId: heartbeatRequestId
  });
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
