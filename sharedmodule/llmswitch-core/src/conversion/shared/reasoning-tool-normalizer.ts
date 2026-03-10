import {
  normalizeChatResponseReasoningToolsWithNative,
  normalizeMessageReasoningToolsWithNative
} from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

type UnknownRecord = Record<string, unknown>;
const MODULE_NAME = 'reasoning-tool-normalizer';

export interface ReasoningNormalizationResult {
  toolCallsAdded: number;
  cleanedReasoning?: string;
}

function assertReasoningToolNormalizerNativeAvailable(): void {
  if (
    typeof normalizeMessageReasoningToolsWithNative !== 'function' ||
    typeof normalizeChatResponseReasoningToolsWithNative !== 'function'
  ) {
    throw new Error(`[${MODULE_NAME}] native bindings unavailable`);
  }
}

export function normalizeMessageReasoningTools(
  message: UnknownRecord | null | undefined,
  options?: { idPrefix?: string }
): ReasoningNormalizationResult {
  assertReasoningToolNormalizerNativeAvailable();
  const normalized = normalizeMessageReasoningToolsWithNative(
    message as UnknownRecord,
    typeof options?.idPrefix === 'string' ? options.idPrefix : undefined
  );
  return {
    toolCallsAdded: normalized.toolCallsAdded,
    ...(typeof normalized.cleanedReasoning === 'string'
      ? { cleanedReasoning: normalized.cleanedReasoning }
      : {})
  };
}

export function normalizeChatResponseReasoningTools(
  response: UnknownRecord | null | undefined,
  options?: { idPrefixBase?: string }
): void {
  assertReasoningToolNormalizerNativeAvailable();
  normalizeChatResponseReasoningToolsWithNative(
    response as UnknownRecord,
    typeof options?.idPrefixBase === 'string' ? options.idPrefixBase : undefined
  );
}
