import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseJson,
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function parseLenientJsonishWithNative(value: unknown): unknown {
  const capability = 'parseLenientJsonishJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairArgumentsToStringWithNative(value: unknown): string {
  const capability = 'repairArgumentsToStringJsonishJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureBridgeInstructionsWithNative(payload: Record<string, unknown>): Record<string, unknown> {
  const capability = 'ensureBridgeInstructionsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
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
