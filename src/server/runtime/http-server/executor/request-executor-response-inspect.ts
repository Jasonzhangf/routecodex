/**
 * Response / Payload Inspection Helpers
 *
 * Extracted from request-executor.ts.
 * Pure inspection functions: check text presence, detect markers,
 * validate payload structure, emit concurrency logs, etc.
 */

import { readString } from './request-executor-error-shared.js';
import {
  REASONING_STOP_FINALIZED_MARKER
} from './servertool-response-normalizer.js';
import { recordVirtualRouterHitRollup } from './log-rollup.js';

type StoplessLogMode = 'on' | 'off' | 'endless';

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

export function emitVirtualRouterConcurrencyLog(args: {
  sessionId?: string;
  projectPath?: string;
  routeName?: string;
  poolId?: string;
  providerKey?: string;
  model?: string;
  reason?: string;
  stoplessMode?: StoplessLogMode;
  stoplessArmed?: boolean;
  activeInFlight: number;
  maxInFlight: number;
}): void {
  recordVirtualRouterHitRollup({
    routeName: args.routeName,
    poolId: args.poolId,
    providerKey: args.providerKey,
    model: args.model,
    sessionId: args.sessionId,
    projectPath: args.projectPath,
    reason: args.reason,
    stoplessMode: args.stoplessMode,
    stoplessArmed: args.stoplessArmed,
    activeInFlight: args.activeInFlight,
    maxInFlight: args.maxInFlight
  });
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

export function readServerToolFollowupSource(requestSemantics?: Record<string, unknown>): string {
  const routecodex =
    requestSemantics?.__routecodex && typeof requestSemantics.__routecodex === 'object' && !Array.isArray(requestSemantics.__routecodex)
      ? (requestSemantics.__routecodex as Record<string, unknown>)
      : undefined;
  const raw = routecodex?.serverToolFollowupSource;
  return typeof raw === 'string' && raw.trim().length ? raw.trim() : '';
}

export function isReasoningStopFollowupTurn(requestSemantics?: Record<string, unknown>): boolean {
  const source = readServerToolFollowupSource(requestSemantics);
  return source === 'servertool.reasoning_stop_guard' || source === 'servertool.reasoning_stop_continue';
}

export function containsReasoningStopFinalizedMarker(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(REASONING_STOP_FINALIZED_MARKER);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsReasoningStopFinalizedMarker(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = readString(value.type)?.toLowerCase();
  if (entryType && entryType !== 'output_text' && entryType !== 'text' && entryType !== 'input_text' && entryType !== 'message') {
    return false;
  }
  if (containsReasoningStopFinalizedMarker(value.output_text)) {
    return true;
  }
  if (containsReasoningStopFinalizedMarker(value.text)) {
    return true;
  }
  if (entryType === 'message') {
    return containsReasoningStopFinalizedMarker(value.content);
  }
  if (Array.isArray(value.content)) {
    return containsReasoningStopFinalizedMarker(value.content);
  }
  return false;
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

export function bodyContainsReasoningStopFinalizedMarker(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (message && containsReasoningStopFinalizedMarker(message.content)) {
      return true;
    }
  }
  if (containsReasoningStopFinalizedMarker(body.output_text)) {
    return true;
  }
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (containsReasoningStopFinalizedMarker(item.output_text)) {
      return true;
    }
    if (containsReasoningStopFinalizedMarker(item.text)) {
      return true;
    }
    if (containsReasoningStopFinalizedMarker(item.content)) {
      return true;
    }
  }
  return false;
}

export function hasAnthropicToolUseSuccess(body: Record<string, unknown>): boolean {
  const data = isRecord(body.data) ? body.data : body;
  const stopReason = readString(data.stop_reason)?.toLowerCase() ?? '';
  const content = Array.isArray(data.content) ? data.content : [];
  const hasToolUseBlock = content.some((item) => isRecord(item) && readString(item.type) === 'tool_use');
  return stopReason === 'tool_use' || hasToolUseBlock;
}
