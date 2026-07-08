import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-loader.js';
import {
  parseJson,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function repairFindMetaWithNative(script: string): string {
  const capability = 'repairFindMetaJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(script ?? '');
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function deriveToolCallKeyWithNative(
  call: Record<string, unknown> | null | undefined
): string | null {
  const capability = 'deriveToolCallKeyJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const callJson = safeStringify(call ?? null);
  if (!callJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(callJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return null;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
