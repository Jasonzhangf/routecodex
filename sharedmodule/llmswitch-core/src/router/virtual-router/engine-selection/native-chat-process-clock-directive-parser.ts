import {
  isNativeDisabledByEnv,
  makeNativeRequiredError
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type ClockDirectiveRecurrenceCandidate = {
  kind: 'daily' | 'weekly' | 'interval';
  maxRuns: number;
  everyMinutes?: number;
};

export type ClockScheduleDirectiveCandidate = {
  dueAt: string;
  task: string;
  recurrence?: ClockDirectiveRecurrenceCandidate;
};

export type ClockDirectiveTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; full: string; candidate?: ClockScheduleDirectiveCandidate };

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

function parseRecurrence(value: unknown): ClockDirectiveRecurrenceCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : '';
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'interval') {
    return undefined;
  }
  const maxRuns = parsePositiveInt(row.maxRuns);
  if (!maxRuns) {
    return undefined;
  }
  if (kind === 'interval') {
    const everyMinutes = parsePositiveInt(row.everyMinutes);
    if (!everyMinutes) {
      return undefined;
    }
    return { kind, maxRuns, everyMinutes };
  }
  return { kind, maxRuns };
}

function parseCandidateRow(value: unknown): ClockScheduleDirectiveCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const dueAt = typeof row.dueAt === 'string' ? row.dueAt.trim() : '';
  const task = typeof row.task === 'string' ? row.task.trim() : '';
  if (!dueAt || !task) {
    return null;
  }
  const recurrence = parseRecurrence(row.recurrence);
  if (row.recurrence !== undefined && !recurrence) {
    return null;
  }
  return recurrence ? { dueAt, task, recurrence } : { dueAt, task };
}

function parseNativeCandidatePayload(raw: string): ClockScheduleDirectiveCandidate | null {
  try {
    return parseCandidateRow(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseNativeTextPart(value: unknown): ClockDirectiveTextPart | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : '';

  if (kind === 'text') {
    const text = typeof row.text === 'string' ? row.text : '';
    return { kind: 'text', text };
  }
  if (kind !== 'directive') {
    return null;
  }

  const full = typeof row.full === 'string' ? row.full : '';
  if (!full) {
    return null;
  }
  const candidateRaw = row.candidate;
  if (candidateRaw === undefined || candidateRaw === null) {
    return { kind: 'directive', full };
  }
  const candidate = parseCandidateRow(candidateRaw);
  if (!candidate) {
    return null;
  }
  return { kind: 'directive', full, candidate };
}

function parseNativeTextPartsPayload(raw: string): ClockDirectiveTextPart[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const partsRaw = Array.isArray(row.parts) ? row.parts : null;
    if (!partsRaw) {
      return null;
    }
    const parts: ClockDirectiveTextPart[] = [];
    for (const item of partsRaw) {
      const part = parseNativeTextPart(item);
      if (!part) {
        return null;
      }
      parts.push(part);
    }
    return parts;
  } catch {
    return null;
  }
}

function toErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown');
}

function requireNativeFunction(capability: string, exportName: string): (...args: string[]) => unknown {
  if (isNativeDisabledByEnv()) {
    throw makeNativeRequiredError(capability, 'native disabled');
  }

  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[exportName];
  if (typeof fn !== 'function') {
    throw makeNativeRequiredError(capability);
  }
  return fn as (...args: string[]) => unknown;
}

export function parseClockScheduleDirectiveCandidateWithNative(
  payload: string
): ClockScheduleDirectiveCandidate | null {
  const capability = 'parseClockScheduleDirectiveCandidateJson';
  const fn = requireNativeFunction(capability, capability);

  let raw: unknown;
  try {
    raw = fn(payload);
  } catch (error) {
    throw makeNativeRequiredError(capability, toErrorReason(error));
  }

  if (typeof raw !== 'string' || !raw) {
    throw makeNativeRequiredError(capability, 'empty result');
  }
  if (raw.trim() === 'null') {
    return null;
  }
  const parsed = parseNativeCandidatePayload(raw);
  if (!parsed) {
    throw makeNativeRequiredError(capability, 'invalid payload');
  }
  return parsed;
}

export function extractClockScheduleDirectiveTextPartsWithNative(text: string): ClockDirectiveTextPart[] {
  const capability = 'extractClockScheduleDirectiveTextPartsJson';
  const fn = requireNativeFunction(capability, capability);

  let raw: unknown;
  try {
    raw = fn(String(text || ''));
  } catch (error) {
    throw makeNativeRequiredError(capability, toErrorReason(error));
  }

  if (typeof raw !== 'string' || !raw) {
    throw makeNativeRequiredError(capability, 'empty result');
  }
  const parsed = parseNativeTextPartsPayload(raw);
  if (!parsed) {
    throw makeNativeRequiredError(capability, 'invalid payload');
  }
  return parsed;
}
