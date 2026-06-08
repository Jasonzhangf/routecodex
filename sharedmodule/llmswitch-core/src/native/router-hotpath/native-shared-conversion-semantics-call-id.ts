import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseJson,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function normalizeFunctionCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeFunctionCallOutputIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallOutputIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeResponsesCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function clampResponsesInputItemIdWithNative(rawValue: unknown): string | undefined {
  const capability = 'clampResponsesInputItemIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawJson = safeStringify(rawValue ?? null);
  if (!rawJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
