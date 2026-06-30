import { containsSyntheticRouteCodexControlTextWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  parseServertoolTimeoutMsWithNative,
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

export function containsSyntheticRouteCodexControlText(value: unknown): boolean {
  return containsSyntheticRouteCodexControlTextWithNative(value);
}
