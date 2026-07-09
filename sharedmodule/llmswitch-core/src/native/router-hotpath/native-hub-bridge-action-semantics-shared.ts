import { failNativeRequired } from './native-router-hotpath-loader.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();

export function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}


export function stringifyNativePayloadForError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (raw instanceof Error) {
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (message.length) {
      return message;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    if (message.length) {
      return message;
    }
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    if (code.length) {
      return code;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export function readNativeJsonResult(capability: string, raw: unknown): string {
  if (typeof raw === 'string') {
    if (!raw) {
      return failNativeRequired<string>(capability, 'empty result');
    }
    return raw;
  }
  const reason = stringifyNativePayloadForError(raw);
  if (reason) {
    throw new Error(reason);
  }
  return failNativeRequired<string>(capability, 'empty result');
}

export function shouldRethrowNativeRawError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return !error.message.startsWith('[virtual-router-native-hotpath] native ');
}

function logNativeBridgeActionParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  const reason = stringifyNativePayloadForError(error) ?? 'unknown';
  console.warn(`[native-hub-bridge-action-semantics] ${stage} parse failed (non-blocking): ${reason}`);
}

export function parseNativeJsonValueOrFail<T>(capability: string, raw: string, stage = capability): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logNativeBridgeActionParserNonBlocking(stage, error);
    return failNativeRequired<T>(capability, 'invalid payload');
  }
}

export function parseNativeJsonObjectOrFail<T extends Record<string, unknown>>(
  capability: string,
  raw: string,
  stage = capability
): T {
  const parsed = parseNativeJsonValueOrFail<unknown>(capability, raw, stage);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failNativeRequired<T>(capability, 'invalid payload');
  }
  return parsed as T;
}
