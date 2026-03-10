import { failNativeRequired } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseRecordPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function serializeStopMessageStateWithNative(
  state: unknown
): Record<string, unknown> {
  const capability = 'serializeStopMessageStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const stateJson = safeStringify(state);
  if (!stateJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(stateJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseRecordPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function deserializeStopMessageStateWithNative(
  data: Record<string, unknown>,
  state: unknown
): Record<string, unknown> {
  const capability = 'deserializeStopMessageStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const dataJson = safeStringify(data);
  const stateJson = safeStringify(state);
  if (!dataJson || !stateJson) {
    return fail('json stringify failed');
  }
  try {
    const result = fn(dataJson, stateJson);
    if (typeof result !== 'string' || !result) {
      return fail('empty result');
    }
    const parsed = parseRecordPayload(result);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
