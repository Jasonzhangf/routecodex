import type { JsonObject } from '../conversion/hub/types/json.js';
import { containsSyntheticRouteCodexControlTextWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  compactFollowupErrorReasonWithNative,
  normalizeClientInjectTextWithNative,
  parseServertoolTimeoutMsWithNative,
  readClientInjectOnlyWithNative,
  resolveAdapterContextProviderKeyWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

// feature_id: hub.servertool_orchestration_policy
export function resolveServerToolTimeoutMs(): number {
  const raw = process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS ||
    process.env.RCC_SERVERTOOL_TIMEOUT_MS ||
    process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS;
  const timeoutPolicyInput = { raw: raw || undefined };
  return parseServertoolTimeoutMsWithNative(timeoutPolicyInput);
}

export function resolveServerToolFollowupTimeoutMs(): number {
  const raw = process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
    process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
    process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
  const followupTimeoutPolicyInput = { raw: raw || undefined };
  return parseServertoolTimeoutMsWithNative(followupTimeoutPolicyInput);
}

export function readClientInjectOnly(metadata: JsonObject): boolean {
  return readClientInjectOnlyWithNative(metadata as Record<string, unknown>);
}

export function normalizeClientInjectText(value: unknown): string {
  return normalizeClientInjectTextWithNative(value);
}

export function compactFollowupErrorReason(value: unknown): string | undefined {
  return compactFollowupErrorReasonWithNative(value);
}

export function resolveAdapterContextProviderKey(adapterContext: unknown): string {
  return resolveAdapterContextProviderKeyWithNative(adapterContext);
}

export function containsSyntheticRouteCodexControlText(value: unknown): boolean {
  return containsSyntheticRouteCodexControlTextWithNative(value);
}
