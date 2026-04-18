import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

const NON_BLOCKING_CLOCK_REMINDER_LOG_THROTTLE_MS = 60_000;
const nonBlockingClockReminderLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-chat-process-clock-reminder-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeClockReminderNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingClockReminderLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_CLOCK_REMINDER_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingClockReminderLogState.set(stage, now);
  console.warn(
    `[native-chat-process-clock-reminder-semantics] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeClockReminderNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function parseArray(raw: string): unknown[] | null {
  const parsed = parseJson('parseArray', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function parseRecordOrNull(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecordOrNull', raw);
  if (parsed === JSON_PARSE_FAILED || parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseRecordOrNullResult(raw: string): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  const parsed = parseJson('parseRecordOrNullResult', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return { ok: false };
  }
  if (parsed === null) {
    return { ok: true, value: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseIndex(raw: string): number | null {
  const parsed = parseJson('parseIndex', raw);
  if (parsed === JSON_PARSE_FAILED || typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function parseStringOrNull(raw: string): string | null | undefined {
  const parsed = parseJson('parseStringOrNull', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return undefined;
  }
  if (parsed === null) {
    return null;
  }
  return typeof parsed === 'string' ? parsed : undefined;
}

function parseClockConfigOrNull(raw: string): Record<string, unknown> | null | undefined {
  const parsed = parseJson('parseClockConfigOrNull', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return undefined;
  }
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function resolveClockConfigWithNative(
  raw: unknown,
  rawIsUndefined: boolean
): Record<string, unknown> | null {
  const capability = 'resolveClockConfigJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const rawResponse = fn(JSON.stringify(raw ?? null), rawIsUndefined === true);
    if (typeof rawResponse !== 'string' || !rawResponse) {
      return fail('empty result');
    }
    const parsed = parseClockConfigOrNull(rawResponse);
    return parsed === undefined ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveClockSessionScopeWithNative(
  primary: Record<string, unknown> | null | undefined,
  fallback: Record<string, unknown> | null | undefined
): string | null {
  const capability = 'resolveClockSessionScopeJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(primary ?? null), JSON.stringify(fallback ?? null));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringOrNull(raw);
    return parsed === undefined ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildClockMarkerScheduleMessagesWithNative(
  requestId: string,
  markerIndex: number,
  marker: Record<string, unknown>,
  payload: Record<string, unknown>
): unknown[] {
  const capability = 'buildClockMarkerScheduleMessagesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildClockMarkerScheduleMessagesJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(requestId, Number.isFinite(markerIndex) ? Math.floor(markerIndex) : 0, JSON.stringify(marker), JSON.stringify(payload));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function findLastUserMessageIndexWithNative(messages: unknown[]): number {
  const capability = 'findLastUserMessageIndexJson';
  const fail = (reason?: string) => failNativeRequired<number>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('findLastUserMessageIndexJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(messages));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseIndex(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectTimeTagIntoMessagesWithNative(
  messages: unknown[],
  timeTagLine: string
): unknown[] {
  const capability = 'injectTimeTagIntoMessagesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('injectTimeTagIntoMessagesJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(messages), timeTagLine);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildDueReminderUserMessageWithNative(
  reservation: unknown,
  dueInjectText: string
): unknown {
  const capability = 'buildDueReminderUserMessageJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildDueReminderUserMessageJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(reservation ?? null), dueInjectText);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecordOrNullResult(raw);
    return parsed.ok ? parsed.value : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildClockReminderMetadataWithNative(
  nextRequestMetadata: unknown,
  metadata: Record<string, unknown>,
  dueUserMessage: unknown,
  reservation: unknown
): Record<string, unknown> {
  const capability = 'buildClockReminderMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildClockReminderMetadataJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(
      JSON.stringify(nextRequestMetadata ?? null),
      JSON.stringify(metadata ?? {}),
      dueUserMessage !== null && dueUserMessage !== undefined,
      JSON.stringify(reservation ?? null)
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildClockReminderMessagesWithNative(
  baseMessages: unknown[],
  markerToolMessages: unknown[],
  dueUserMessage: unknown,
  timeTagLine: string
): unknown[] {
  const capability = 'buildClockReminderMessagesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('buildClockReminderMessagesJson');
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(
      JSON.stringify(baseMessages),
      JSON.stringify(markerToolMessages),
      JSON.stringify(dueUserMessage ?? null),
      timeTagLine
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
