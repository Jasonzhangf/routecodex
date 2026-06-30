import type {
  ResponsesMessageItem,
  ResponsesOutputItem,
  ResponsesReasoningItem
} from '../types/index.js';
import {
  expandResponsesMessageItemWithNative,
  normalizeResponsesMessageItemWithNative,
  normalizeResponsesOutputItemsWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export type ResponsesMessageNormalizationOptions = Record<string, unknown>;

export interface ResponsesMessageNormalizationResult {
  message: ResponsesMessageItem;
  reasoning?: ResponsesReasoningItem;
}

export function normalizeResponsesMessageItem(
  item: ResponsesMessageItem,
  options: ResponsesMessageNormalizationOptions
): ResponsesMessageNormalizationResult {
  const normalized = normalizeResponsesMessageItemWithNative(item, options);
  return {
    message: normalized.message as unknown as ResponsesMessageItem,
    ...(normalized.reasoning
      ? { reasoning: normalized.reasoning as unknown as ResponsesReasoningItem }
      : {})
  };
}

export function expandResponsesMessageItem(
  item: ResponsesMessageItem,
  options: ResponsesMessageNormalizationOptions
): ResponsesOutputItem[] {
  return expandResponsesMessageItemWithNative(item, options) as unknown as ResponsesOutputItem[];
}

export function normalizeResponsesOutputItems(
  output: ResponsesOutputItem[] | undefined
): ResponsesOutputItem[] {
  return normalizeResponsesOutputItemsWithNative(output) as unknown as ResponsesOutputItem[];
}
