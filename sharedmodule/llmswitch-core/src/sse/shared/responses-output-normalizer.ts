import type {
  ResponsesContent,
  ResponsesMessageItem,
  ResponsesOutputItem,
  ResponsesReasoningItem
} from '../types/index.js';
import { normalizeMessageContentParts } from '../../conversion/shared/output-content-normalizer.js';

export interface ResponsesMessageNormalizationOptions {
  requestId?: string;
  outputIndex?: number;
  extraReasoning?: string | string[];
  suppressReasoningFromContent?: boolean;
}

export interface ResponsesMessageNormalizationResult {
  message: ResponsesMessageItem;
  reasoning?: ResponsesReasoningItem;
}

export function normalizeResponsesMessageItem(
  item: ResponsesMessageItem,
  _options: ResponsesMessageNormalizationOptions
): ResponsesMessageNormalizationResult {
  const baseId = typeof item.id === 'string' ? item.id.trim() : '';
  if (!baseId) {
    throw new Error('Invalid Responses message: missing id');
  }
  const { normalizedParts, reasoningChunks: extractedReasoning } = normalizeMessageContentParts(item.content);
  const reasoningChunks = _options.suppressReasoningFromContent ? [] : extractedReasoning;
  const additionalReasoning = _options.extraReasoning;
  if (additionalReasoning) {
    const extras = Array.isArray(additionalReasoning) ? additionalReasoning : [additionalReasoning];
    for (const entry of extras) {
      if (typeof entry === 'string') {
        if (entry.length) {
          reasoningChunks.push(entry);
        }
      }
    }
  }
  const normalizedContent: ResponsesContent[] = normalizedParts.length
    ? (normalizedParts as ResponsesContent[])
    : [{ type: 'output_text', text: '' }];

  const message: ResponsesMessageItem = {
    ...item,
    id: baseId,
    content: normalizedContent
  };

  let reasoning: ResponsesReasoningItem | undefined;
  if (reasoningChunks.length) {
    reasoning = {
      id: `${baseId}_reasoning`,
      type: 'reasoning',
      summary: [],
      content: reasoningChunks.map((text) => ({ type: 'reasoning_text', text }))
    };
  }

  return { message, reasoning };
}

export function expandResponsesMessageItem(
  item: ResponsesMessageItem,
  options: ResponsesMessageNormalizationOptions
): ResponsesOutputItem[] {
  const { message, reasoning } = normalizeResponsesMessageItem(item, options);
  // Responses upstream (legacy + CCR) emitted reasoning segments before the final assistant message.
  // Preserve that ordering so roundtrip comparisons against provider snapshots remain identical.
  return reasoning ? [reasoning, message] : [message];
}
