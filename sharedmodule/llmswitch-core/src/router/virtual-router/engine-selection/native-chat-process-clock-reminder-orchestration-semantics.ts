import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type NativeGuardedClockScheduleItem = {
  dueAtMs: number;
  setBy?: string;
  task: string;
  recurrence?: unknown;
  notBeforeRequestId?: string;
};

function parseGuardedItem(raw: string): NativeGuardedClockScheduleItem | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const dueAtMs = Number(row.dueAtMs);
    const setBy = typeof row.setBy === 'string' ? row.setBy : '';
    const task = typeof row.task === 'string' ? row.task : '';
    if (!Number.isFinite(dueAtMs) || !task.trim()) {
      return null;
    }
    const notBeforeRequestId =
      typeof row.notBeforeRequestId === 'string' && row.notBeforeRequestId.trim()
        ? row.notBeforeRequestId
        : undefined;
    return {
      dueAtMs: Math.floor(dueAtMs),
      ...(setBy.trim() ? { setBy } : {}),
      task,
      ...(row.recurrence !== undefined ? { recurrence: row.recurrence } : {}),
      ...(notBeforeRequestId ? { notBeforeRequestId } : {})
    };
  } catch {
    return null;
  }
}

function parseJsonString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function buildGuardedClockScheduleItemWithNative(
  marker: unknown,
  requestId: string,
  dueWindowMs: number,
  nowMs: number
): NativeGuardedClockScheduleItem {
  const capability = 'buildGuardedClockScheduleItemJson';
  const fail = (reason?: string) => failNativeRequired<NativeGuardedClockScheduleItem>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.buildGuardedClockScheduleItemJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(
      JSON.stringify(marker ?? null),
      String(requestId || ''),
      Number.isFinite(dueWindowMs) ? dueWindowMs : 0,
      Number.isFinite(nowMs) ? nowMs : 0
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseGuardedItem(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeDueInjectTextWithNative(
  value: unknown
): string {
  const capability = 'normalizeDueInjectTextJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.normalizeDueInjectTextJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(value ?? null));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJsonString(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function shouldReserveClockDueReminderWithNative(
  hadClear: boolean,
  sessionId: string | null
): boolean {
  const capability = 'shouldReserveClockDueReminderJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.shouldReserveClockDueReminderJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(hadClear === true, String(sessionId ?? ''));
    return raw === true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
