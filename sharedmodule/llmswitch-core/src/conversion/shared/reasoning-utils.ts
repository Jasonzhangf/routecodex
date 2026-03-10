import {
  extractReasoningSegmentsWithNative,
  sanitizeReasoningTaggedTextWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

function assertReasoningUtilsNativeAvailable(): void {
  if (
    typeof extractReasoningSegmentsWithNative !== 'function' ||
    typeof sanitizeReasoningTaggedTextWithNative !== 'function'
  ) {
    throw new Error('[reasoning-utils] native bindings unavailable');
  }
}

export function extractReasoningSegments(source: string, reasoningCollector?: string[]): string {
  assertReasoningUtilsNativeAvailable();
  const output = extractReasoningSegmentsWithNative(source ?? '');
  if (reasoningCollector) {
    reasoningCollector.push(...output.segments);
  }
  return output.text;
}

export function sanitizeReasoningTaggedText(value: string): string {
  assertReasoningUtilsNativeAvailable();
  return sanitizeReasoningTaggedTextWithNative(value);
}
