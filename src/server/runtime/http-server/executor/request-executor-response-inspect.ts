/**
 * Response / Payload Inspection Helpers
 *
 * Extracted from request-executor.ts.
 * Pure inspection functions: check text presence, detect markers,
 * validate payload structure, etc.
 */

// feature_id: server.response_inspection_helpers
import { readString } from './request-executor-error-shared.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function valueHasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasNonEmptyText(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    valueHasNonEmptyText(value.text)
    || valueHasNonEmptyText(value.output_text)
    || valueHasNonEmptyText(value.content)
    || valueHasNonEmptyText(value.reasoning_content)
    || valueHasNonEmptyText(value.reasoning)
  );
}

export function valueHasVisibleAssistantText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasVisibleAssistantText(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = readString(value.type)?.toLowerCase();
  if (entryType === 'thinking' || entryType === 'reasoning') {
    return false;
  }
  return (
    valueHasVisibleAssistantText(value.text)
    || valueHasVisibleAssistantText(value.output_text)
    || valueHasVisibleAssistantText(value.content)
  );
}

export function extractTextFromResponsesOutputItem(item: unknown): string {
  if (!isRecord(item)) {
    return '';
  }
  const itemType = readString(item.type)?.toLowerCase();
  const directOutputText = readString(item.output_text);
  if (directOutputText) {
    return directOutputText;
  }
  if (itemType === 'output_text' || itemType === 'text' || itemType === 'input_text') {
    const direct = readString(item.text);
    if (direct) {
      return direct;
    }
  }
  if (itemType === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    const chunks: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const partType = readString(part.type)?.toLowerCase();
      if (partType && partType !== 'output_text' && partType !== 'text' && partType !== 'input_text') {
        continue;
      }
      const partText = readString(part.text) ?? readString(part.output_text);
      if (partText) {
        chunks.push(partText);
      }
    }
    return chunks.join('');
  }
  return '';
}

export function hasNonEmptyToolCalls(value: unknown): boolean {
  if (!Array.isArray(value) || value.length <= 0) {
    return false;
  }
  return value.some((item) => isRecord(item));
}

export function hasOutputFunctionCalls(value: unknown): boolean {
  if (!Array.isArray(value) || value.length <= 0) {
    return false;
  }
  return value.some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const itemType = readString(item.type)?.toLowerCase();
    if (itemType === 'function_call' || itemType === 'function') {
      return true;
    }
    if (hasNonEmptyToolCalls(item.tool_calls)) {
      return true;
    }
    return false;
  });
}

export function containsToolRegistryMissingText(value: unknown): boolean {
  if (!valueHasNonEmptyText(value)) {
    return false;
  }
  const text = String(value ?? '');
  const pattern = /tool\s+[a-z0-9_.-]+\s+does\s+not\s+exist(?:s)?/ig;
  let count = 0;
  while (pattern.exec(text)) {
    count += 1;
    if (count >= 1) {
      return true;
    }
  }
  return false;
}

export const EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER =
  '[RouteCodex] assistant response became empty after response sanitization.';

export function containsEmptyAssistantSanitizedPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsEmptyAssistantSanitizedPlaceholder(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value as Record<string, unknown>)
    .some((entry) => containsEmptyAssistantSanitizedPlaceholder(entry));
}

export type PayloadContractSignal = {
  reason: string;
  marker: string;
};

export function valueHasNonEmptyPayloadContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueHasNonEmptyPayloadContent(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return [
    record.content,
    record.text,
    record.prompt,
    record.input_text,
    record.query,
    record.instructions,
    record.instruction,
    record.message,
    record.messages,
    record.input,
    record.contents,
    record.parts
  ].some((entry) => valueHasNonEmptyPayloadContent(entry));
}

export function unwrapProviderRequestPayloadBody(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

export function hasAnthropicToolUseSuccess(body: Record<string, unknown>): boolean {
  const data = isRecord(body.data) ? body.data : body;
  const stopReason = readString(data.stop_reason)?.toLowerCase() ?? '';
  const content = Array.isArray(data.content) ? data.content : [];
  const hasToolUseBlock = content.some((item) => isRecord(item) && readString(item.type) === 'tool_use');
  return stopReason === 'tool_use' || hasToolUseBlock;
}
