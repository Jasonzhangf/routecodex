import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function parseHint(raw: string): Record<string, unknown> | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const hint: Record<string, unknown> = {};
    if (row.force === true) {
      hint.force = true;
    }
    if (row.disable === true) {
      hint.disable = true;
    }
    return Object.keys(hint).length ? hint : undefined;
  } catch {
    return null;
  }
}

export function extractWebSearchSemanticsHintWithNative(
  semantics: unknown
): Record<string, unknown> | undefined {
  const capability = 'extractWebSearchSemanticsHintJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.extractWebSearchSemanticsHintJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(semantics ?? null));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseHint(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
