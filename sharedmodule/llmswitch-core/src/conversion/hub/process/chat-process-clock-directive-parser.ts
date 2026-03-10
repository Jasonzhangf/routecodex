import { parseDueAtMs, type ClockTaskRecurrence } from '../../../servertool/clock/task-store.js';
import {
  parseClockScheduleDirectiveCandidateWithNative,
  type ClockScheduleDirectiveCandidate
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-directive-parser.js';
import type { ClockScheduleDirective } from './chat-process-clock-directives.js';

function normalizeRecurrence(
  recurrence: ClockScheduleDirectiveCandidate['recurrence']
): ClockTaskRecurrence | undefined {
  if (!recurrence) {
    return undefined;
  }
  if (recurrence.kind === 'interval') {
    if (typeof recurrence.everyMinutes !== 'number' || recurrence.everyMinutes <= 0) {
      return undefined;
    }
    return {
      kind: 'interval',
      maxRuns: Math.floor(recurrence.maxRuns),
      everyMinutes: Math.floor(recurrence.everyMinutes)
    };
  }
  return {
    kind: recurrence.kind,
    maxRuns: Math.floor(recurrence.maxRuns)
  };
}

export function hydrateClockScheduleDirectiveCandidate(
  candidate: ClockScheduleDirectiveCandidate
): ClockScheduleDirective | null {
  const dueAtMs = parseDueAtMs(candidate.dueAt);
  if (!dueAtMs || !candidate.task) {
    return null;
  }
  const recurrence = normalizeRecurrence(candidate.recurrence);
  if (candidate.recurrence && !recurrence) {
    return null;
  }
  return {
    dueAtMs,
    dueAt: new Date(dueAtMs).toISOString(),
    task: candidate.task,
    ...(recurrence ? { recurrence } : {})
  };
}

export function parseClockScheduleDirectiveCandidatePayload(
  payload: string
): ClockScheduleDirectiveCandidate | null {
  const raw = String(payload || '').trim();
  return parseClockScheduleDirectiveCandidateWithNative(raw);
}

export function parseClockScheduleDirectivePayload(payload: string): ClockScheduleDirective | null {
  const candidate = parseClockScheduleDirectiveCandidatePayload(payload);
  if (!candidate) {
    return null;
  }
  return hydrateClockScheduleDirectiveCandidate(candidate);
}
