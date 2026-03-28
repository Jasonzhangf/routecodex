import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export type NativeClockReminderFlowPlan = {
  skipForServerToolFollowup: boolean;
  injectPerRequestTimeTag: boolean;
};

function parsePayload(raw: string): NativeClockReminderFlowPlan | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.skipForServerToolFollowup !== 'boolean') {
      return null;
    }
    const injectPerRequestTimeTag =
      typeof row.injectPerRequestTimeTag === 'boolean' ? row.injectPerRequestTimeTag : false;
    return {
      skipForServerToolFollowup: row.skipForServerToolFollowup,
      injectPerRequestTimeTag
    };
  } catch {
    return null;
  }
}

export function resolveClockReminderFlowPlanWithNative(
  runtimeMetadata: Record<string, unknown>
): NativeClockReminderFlowPlan {
  const capability = 'resolveClockReminderFlowPlanJson';
  const fail = (reason?: string) => failNativeRequired<NativeClockReminderFlowPlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.resolveClockReminderFlowPlanJson;
  if (typeof fn !== 'function') {
    return fail();
  }
  try {
    const raw = fn(JSON.stringify(runtimeMetadata ?? {}));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parsePayload(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
