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
function resolveServerToolTimeoutMsFromEnv(keys: string[]): number {
  const raw = keys.map((key) => process.env[key]).find((value) => Boolean(value));
  return parseServertoolTimeoutMsWithNative({ raw: raw || undefined });
}

export function resolveServerToolTimeoutMs(): number {
  return resolveServerToolTimeoutMsFromEnv([
    'ROUTECODEX_SERVERTOOL_TIMEOUT_MS',
    'RCC_SERVERTOOL_TIMEOUT_MS',
    'LLMSWITCH_SERVERTOOL_TIMEOUT_MS'
  ]);
}

export function resolveServerToolFollowupTimeoutMs(): number {
  return resolveServerToolTimeoutMsFromEnv([
    'ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS',
    'RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS',
    'LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS'
  ]);
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
