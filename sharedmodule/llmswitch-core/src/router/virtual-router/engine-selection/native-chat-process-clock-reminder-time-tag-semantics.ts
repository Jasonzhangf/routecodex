import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export function resolveClockTimeTagFallbackLineWithNative(
  fallbackLine: string | undefined,
  defaultLine: string
): string {
  const capability = 'resolveClockTimeTagFallbackLineJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.resolveClockTimeTagFallbackLineJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(String(fallbackLine ?? ''), String(defaultLine || ''));
    if (typeof raw !== 'string' || !raw.trim()) {
      return fail('empty result');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
