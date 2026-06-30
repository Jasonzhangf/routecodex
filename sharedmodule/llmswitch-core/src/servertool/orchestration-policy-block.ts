import { containsSyntheticRouteCodexControlTextWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  parseServertoolTimeoutMsWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';

// feature_id: hub.servertool_orchestration_policy
export function resolveServerToolTimeoutMs(): number {
  const raw = [
    'ROUTECODEX_SERVERTOOL_TIMEOUT_MS',
    'RCC_SERVERTOOL_TIMEOUT_MS',
    'LLMSWITCH_SERVERTOOL_TIMEOUT_MS'
  ].map((key) => process.env[key]).find((value) => Boolean(value));
  return parseServertoolTimeoutMsWithNative({ raw: raw || undefined });
}

export function containsSyntheticRouteCodexControlText(value: unknown): boolean {
  return containsSyntheticRouteCodexControlTextWithNative(value);
}
