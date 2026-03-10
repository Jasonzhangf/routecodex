import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import type { ClockScheduleDirectiveCandidate } from './native-chat-process-clock-directive-parser.js';

export type NativeClockReminderDirectiveExtractionPayload = {
  hadClear: boolean;
  directiveCandidates: ClockScheduleDirectiveCandidate[];
  baseMessages: unknown[];
};

function parseCandidate(value: unknown): ClockScheduleDirectiveCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const dueAt = typeof row.dueAt === 'string' ? row.dueAt.trim() : '';
  const task = typeof row.task === 'string' ? row.task.trim() : '';
  if (!dueAt || !task) {
    return null;
  }
  const recurrenceRaw = row.recurrence;
  if (recurrenceRaw === undefined || recurrenceRaw === null) {
    return { dueAt, task };
  }
  if (!recurrenceRaw || typeof recurrenceRaw !== 'object' || Array.isArray(recurrenceRaw)) {
    return null;
  }
  const recurrence = recurrenceRaw as Record<string, unknown>;
  const kind = typeof recurrence.kind === 'string' ? recurrence.kind.trim() : '';
  const maxRuns = Number(recurrence.maxRuns);
  if (!Number.isFinite(maxRuns) || Math.floor(maxRuns) <= 0) {
    return null;
  }
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'interval') {
    return null;
  }
  if (kind === 'interval') {
    const everyMinutes = Number(recurrence.everyMinutes);
    if (!Number.isFinite(everyMinutes) || Math.floor(everyMinutes) <= 0) {
      return null;
    }
    return {
      dueAt,
      task,
      recurrence: {
        kind,
        maxRuns: Math.floor(maxRuns),
        everyMinutes: Math.floor(everyMinutes)
      }
    };
  }
  return {
    dueAt,
    task,
    recurrence: {
      kind,
      maxRuns: Math.floor(maxRuns)
    }
  };
}

function parsePayload(raw: string): NativeClockReminderDirectiveExtractionPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const hadClear = row.hadClear === true;
    const baseMessages = Array.isArray(row.baseMessages) ? row.baseMessages : null;
    const directiveCandidatesRaw = Array.isArray(row.directiveCandidates) ? row.directiveCandidates : null;
    if (!baseMessages || !directiveCandidatesRaw) {
      return null;
    }
    const directiveCandidates: ClockScheduleDirectiveCandidate[] = [];
    for (const entry of directiveCandidatesRaw) {
      const candidate = parseCandidate(entry);
      if (!candidate) {
        return null;
      }
      directiveCandidates.push(candidate);
    }
    return { hadClear, directiveCandidates, baseMessages };
  } catch {
    return null;
  }
}

export function extractClockReminderDirectivesWithNative(
  messages: unknown[]
): NativeClockReminderDirectiveExtractionPayload {
  const capability = 'extractClockReminderDirectivesJson';
  const fail = (reason?: string) => failNativeRequired<NativeClockReminderDirectiveExtractionPayload>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.extractClockReminderDirectivesJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(messages));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parsePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
