import { normalizeMessageReasoningToolsWithNative } from '../../native/router-hotpath/native-hub-bridge-action-semantics.js';

type UnknownRecord = Record<string, unknown>;
const MODULE_NAME = 'reasoning-tool-normalizer';

function assertReasoningToolNormalizerNativeAvailable(): void {
  if (typeof normalizeMessageReasoningToolsWithNative !== 'function') {
    throw new Error(`[${MODULE_NAME}] native bindings unavailable`);
  }
}

function applyNormalizedMessage(
  target: UnknownRecord | null | undefined,
  normalized: UnknownRecord | null | undefined
): void {
  if (!target || !normalized) {
    return;
  }
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      delete target[key];
    }
  }
  Object.assign(target, normalized);
}

export function normalizeMessageReasoningTools(
  message: UnknownRecord | null | undefined,
  options?: { idPrefix?: string }
): {
  toolCallsAdded: number;
  cleanedReasoning?: string;
} {
  assertReasoningToolNormalizerNativeAvailable();
  const normalized = normalizeMessageReasoningToolsWithNative(
    message as UnknownRecord,
    typeof options?.idPrefix === 'string' ? options.idPrefix : undefined
  );
  applyNormalizedMessage(message, normalized.message);
  return {
    toolCallsAdded: normalized.toolCallsAdded,
    ...(typeof normalized.cleanedReasoning === 'string'
      ? { cleanedReasoning: normalized.cleanedReasoning }
      : {})
  };
}
