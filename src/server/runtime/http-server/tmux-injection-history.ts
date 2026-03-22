import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveTmuxInjectionLoggingConfig } from './tmux-injection-runtime-config.js';

type TmuxInjectionSource = 'clock' | 'heartbeat';
type TmuxInjectionOutcome = 'triggered' | 'skipped' | 'failed' | 'disabled';

type TmuxInjectionCounterState = {
  version: 1;
  updatedAtMs: number;
  totalTriggered: number;
  bySource: Record<TmuxInjectionSource, number>;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sanitizeCounterState(raw: unknown): TmuxInjectionCounterState {
  const base: TmuxInjectionCounterState = {
    version: 1,
    updatedAtMs: Date.now(),
    totalTriggered: 0,
    bySource: {
      clock: 0,
      heartbeat: 0
    }
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const row = raw as Record<string, unknown>;
  const totalRaw = Number(row.totalTriggered);
  const bySourceRaw =
    row.bySource && typeof row.bySource === 'object' && !Array.isArray(row.bySource)
      ? (row.bySource as Record<string, unknown>)
      : {};
  return {
    version: 1,
    updatedAtMs: Date.now(),
    totalTriggered: Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : 0,
    bySource: {
      clock: Number.isFinite(Number(bySourceRaw.clock)) && Number(bySourceRaw.clock) >= 0
        ? Math.floor(Number(bySourceRaw.clock))
        : 0,
      heartbeat: Number.isFinite(Number(bySourceRaw.heartbeat)) && Number(bySourceRaw.heartbeat) >= 0
        ? Math.floor(Number(bySourceRaw.heartbeat))
        : 0
    }
  };
}

async function loadCounterState(counterPath: string): Promise<TmuxInjectionCounterState> {
  try {
    const raw = await fs.readFile(counterPath, 'utf8');
    const parsed = JSON.parse(raw);
    return sanitizeCounterState(parsed);
  } catch {
    return sanitizeCounterState(undefined);
  }
}

async function saveCounterState(counterPath: string, state: TmuxInjectionCounterState): Promise<void> {
  const tempPath = `${counterPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, counterPath);
}

export async function appendTmuxInjectionHistoryEvent(input: {
  source: TmuxInjectionSource;
  outcome: TmuxInjectionOutcome;
  tmuxSessionId?: string;
  sessionId?: string;
  reason?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const logging = resolveTmuxInjectionLoggingConfig();
  if (!logging.enabled) {
    return;
  }

  try {
    await fs.mkdir(path.dirname(logging.logFile), { recursive: true });
  } catch {
    return;
  }

  const atMs = Date.now();
  const counterState = await loadCounterState(logging.counterFile);
  if (input.outcome === 'triggered') {
    counterState.totalTriggered += 1;
    counterState.bySource[input.source] += 1;
    counterState.updatedAtMs = atMs;
    await saveCounterState(logging.counterFile, counterState).catch(() => {});
  }

  const event = {
    version: 1,
    atMs,
    source: input.source,
    outcome: input.outcome,
    ...(readString(input.tmuxSessionId) ? { tmuxSessionId: readString(input.tmuxSessionId) } : {}),
    ...(readString(input.sessionId) ? { sessionId: readString(input.sessionId) } : {}),
    ...(readString(input.reason) ? { reason: readString(input.reason) } : {}),
    ...(readString(input.requestId) ? { requestId: readString(input.requestId) } : {}),
    ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
    counters: {
      totalTriggered: counterState.totalTriggered,
      bySource: counterState.bySource
    }
  };

  await fs.appendFile(logging.logFile, `${JSON.stringify(event)}\n`, 'utf8').catch(() => {});
}
