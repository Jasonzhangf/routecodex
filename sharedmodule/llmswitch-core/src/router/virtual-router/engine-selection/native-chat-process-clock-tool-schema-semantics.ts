import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function parseOperations(raw: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch {
    return null;
  }
}

export function buildClockToolAppendOperationsWithNative(
  hasSessionId: boolean,
  clockTool: unknown
): Record<string, unknown>[] {
  const capability = 'buildClockToolAppendOperationsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.buildClockToolAppendOperationsJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(hasSessionId === true, JSON.stringify(clockTool ?? null));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOperations(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildClockStandardToolAppendOperationsWithNative(
  standardTools: unknown[]
): Record<string, unknown>[] {
  const capability = 'buildClockStandardToolAppendOperationsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.buildClockStandardToolAppendOperationsJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(Array.isArray(standardTools) ? standardTools : []));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOperations(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
