import type { TextMarkupNormalizeOptions } from '../../types/text-markup-normalizer.js';
import { normalizeAssistantTextToToolCallsWithNative } from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

function enabled(): boolean {
  try {
    return String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

export function normalizeAssistantTextToToolCalls(
  message: Record<string, any>,
  options?: TextMarkupNormalizeOptions
): Record<string, any> {
  if (!enabled()) return message;
  return normalizeAssistantTextToToolCallsWithNative(message, options) as Record<string, any>;
}
