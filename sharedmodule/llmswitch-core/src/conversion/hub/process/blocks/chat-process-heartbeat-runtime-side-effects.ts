import fs from 'node:fs/promises';
import path from 'node:path';

import type { ProcessedRequest } from '../../types/standardized.js';
import {
  setHeartbeatEnabled,
  startHeartbeatDaemonIfNeeded
} from '../../../../servertool/heartbeat/task-store.js';
import { isRecord } from '../../../../shared/common-utils.js';

export interface HeartbeatDirectiveRuntimeSummary {
  action: 'on' | 'off';
  intervalMs?: number;
  tmuxSessionId?: string;
  workdir?: string;
  contentChanged?: boolean;
}

function logHeartbeatDirectiveNonBlockingError(
  operation: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const detailPairs = Object.entries(details || {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  const suffix = detailPairs ? ` ${suffixSanitize(detailPairs)}` : '';
  console.warn(`[heartbeat-directives] ${operation} failed (non-blocking): ${reason}${suffix}`);
}

function suffixSanitize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function readTmuxSessionId(source?: Record<string, unknown> | null): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const candidates = [
    record.tmuxSessionId,
    record.clientTmuxSessionId,
    record.tmux_session_id,
    record.client_tmux_session_id,
    record.stopMessageClientInjectSessionScope,
    record.stop_message_client_inject_session_scope
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('tmux:')) {
      return trimmed.slice('tmux:'.length).trim() || undefined;
    }
    return trimmed;
  }
  return undefined;
}

export function readWorkdirFromRecord(record?: Record<string, unknown> | null): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const directCandidates = [
    record.workdir,
    record.cwd,
    record.workingDirectory,
    record.clientWorkdir
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  const rt = (record as { __rt?: unknown }).__rt;
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
    return undefined;
  }
  const rtRecord = rt as Record<string, unknown>;
  const rtCandidates = [
    rtRecord.workdir,
    rtRecord.cwd,
    rtRecord.workingDirectory,
    rtRecord.clientWorkdir
  ];
  for (const candidate of rtCandidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function stripHeartbeatStopMarkerFromText(raw: string): { updated: string; changed: boolean } {
  const lines = String(raw || '').split(/\r?\n/);
  let changed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*Heartbeat-Stop-When:\s*.+$/i.test(line)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  return { updated: kept.join('\n'), changed };
}

async function clearHeartbeatStopMarkerForReactivation(workdir: string | undefined): Promise<void> {
  if (!workdir) {
    return;
  }
  const heartbeatPath = path.join(workdir, 'HEARTBEAT.md');
  let raw = '';
  try {
    raw = await fs.readFile(heartbeatPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const stripped = stripHeartbeatStopMarkerFromText(raw);
  if (!stripped.changed) {
    return;
  }
  await fs.writeFile(heartbeatPath, stripped.updated, 'utf8');
}

export async function applyHeartbeatDirectiveRuntimeSideEffects(
  directive: HeartbeatDirectiveRuntimeSummary | null | undefined
): Promise<void> {
  if (!directive || !directive.tmuxSessionId || !directive.action) {
    return;
  }
  const tmuxSessionId = directive.tmuxSessionId.trim();
  if (!tmuxSessionId) {
    return;
  }
  const intervalMs = typeof directive.intervalMs === 'number' ? directive.intervalMs : undefined;
  try {
    if (directive.action === 'off') {
      await setHeartbeatEnabled(tmuxSessionId, false, {
        clearIntervalOverride: true,
        source: 'directive',
        reason: 'disabled_by_directive'
      });
      return;
    }
    await setHeartbeatEnabled(
      tmuxSessionId,
      true,
      typeof intervalMs === 'number'
        ? { intervalMs, source: 'directive' }
        : { clearIntervalOverride: true, source: 'directive' }
    );
    try {
      await clearHeartbeatStopMarkerForReactivation(directive.workdir);
    } catch (error) {
      logHeartbeatDirectiveNonBlockingError('clearHeartbeatStopMarkerForReactivation', error, {
        tmuxSessionId,
        workdir: directive.workdir || 'n/a'
      });
    }
    try {
      await startHeartbeatDaemonIfNeeded(undefined);
    } catch (error) {
      logHeartbeatDirectiveNonBlockingError('startHeartbeatDaemonIfNeeded', error, {
        tmuxSessionId,
        action: directive.action,
        ...(typeof intervalMs === 'number' ? { intervalMs } : {})
      });
    }
  } catch (error) {
    logHeartbeatDirectiveNonBlockingError('setHeartbeatEnabled', error, {
      tmuxSessionId,
      action: directive.action,
      ...(typeof intervalMs === 'number' ? { intervalMs } : {})
    });
  }
}

export function readHeartbeatDirectiveRuntimeSummaryFromProcessedRequest(
  processedRequest: ProcessedRequest
): HeartbeatDirectiveRuntimeSummary | null {
  const processingMetadata = processedRequest.processingMetadata as Record<string, unknown> | undefined;
  const heartbeatDirective = processingMetadata?.heartbeatDirective;
  if (!isRecord(heartbeatDirective)) {
    return null;
  }
  const action = heartbeatDirective.action;
  if (action !== 'on' && action !== 'off') {
    return null;
  }
  const intervalMs = typeof heartbeatDirective.intervalMs === 'number'
    ? heartbeatDirective.intervalMs
    : undefined;
  const tmuxSessionId = typeof heartbeatDirective.tmuxSessionId === 'string'
    ? heartbeatDirective.tmuxSessionId.trim() || undefined
    : undefined;
  const workdir = typeof heartbeatDirective.workdir === 'string'
    ? heartbeatDirective.workdir.trim() || undefined
    : undefined;
  const contentChanged = heartbeatDirective.contentChanged === true;
  return {
    action,
    intervalMs,
    tmuxSessionId,
    workdir,
    contentChanged
  };
}

export async function applyHeartbeatDirectiveRuntimeSideEffectsFromProcessedRequest(
  processedRequest: ProcessedRequest
): Promise<void> {
  await applyHeartbeatDirectiveRuntimeSideEffects(
    readHeartbeatDirectiveRuntimeSummaryFromProcessedRequest(processedRequest)
  );
}
