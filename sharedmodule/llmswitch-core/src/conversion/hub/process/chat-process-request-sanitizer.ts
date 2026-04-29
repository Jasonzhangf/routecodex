import type { StandardizedRequest, ToolCall, StandardizedMessage } from '../types/standardized.js';
import { stripGenericMarkersFromRequest } from './chat-process-generic-marker-strip.js';

const TEMPLATE_ASSISTANT_PATTERNS = [
  /^i['’]m here to help\. what would you like me to do\??$/i,
  /^i['’]m ready to help you with whatever you need\.[\s\S]*what would you like me to do\??$/i
];

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) {
        parts.push(item.trim());
      }
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const directKeys = ['text', 'output_text', 'input_text', 'content'] as const;
    for (const key of directKeys) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) {
        parts.push(value.trim());
      }
    }
  }
  return parts.join(' ').trim();
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolCalls(
  calls: unknown[],
  _messageIndex: number
): { normalized: ToolCall[]; ids: string[] } {
  const normalized: ToolCall[] = [];
  const ids: string[] = [];
  for (const item of calls) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const call = { ...(item as Record<string, unknown>) };
    const normalizedId =
      readNonEmptyString(call.id) ??
      readNonEmptyString(call.call_id) ??
      readNonEmptyString(call.tool_call_id);
    if (!normalizedId) {
      continue;
    }
    call.id = normalizedId;
    delete call.call_id;
    delete call.tool_call_id;
    ids.push(normalizedId);
    normalized.push(call as unknown as ToolCall);
  }
  return { normalized, ids };
}

function isTemplateAssistantText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }
  return TEMPLATE_ASSISTANT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function sanitizeChatProcessRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const sanitized = stripGenericMarkersFromRequest(request);
  if (!Array.isArray(sanitized.messages) || !sanitized.messages.length) {
    return sanitized;
  }

  let removedEmptyAssistantTurns = 0;
  let removedTemplateAssistantTurns = 0;
  const pendingToolCallIds: string[] = [];

  const messages: StandardizedMessage[] = [];
  sanitized.messages.forEach((rawMessage, index) => {
    const message = rawMessage;
    if (!message || typeof message !== 'object') {
      return;
    }
    const role = typeof message.role === 'string' ? message.role.toLowerCase().trim() : '';
    if (role === 'assistant') {
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (hasToolCalls) {
        const rawToolCalls = message.tool_calls as unknown[];
        const { normalized, ids } = normalizeToolCalls(rawToolCalls, index);
        if (normalized.length !== rawToolCalls.length) {
          messages.push(message);
          return;
        }
        if (ids.length > 0) {
          pendingToolCallIds.push(...ids);
        }
        messages.push({
          ...message,
          tool_calls: normalized
        });
        return;
      }
      const text = extractMessageText(message.content);
      if (!text) {
        removedEmptyAssistantTurns += 1;
        return;
      }
      if (isTemplateAssistantText(text)) {
        removedTemplateAssistantTurns += 1;
        return;
      }
      messages.push(message);
      return;
    }
    if (role === 'tool') {
      const messageRecord = message as unknown as Record<string, unknown>;
      let toolCallId =
        readNonEmptyString(message.tool_call_id) ??
        readNonEmptyString(messageRecord.call_id) ??
        readNonEmptyString(messageRecord.id);
      if (toolCallId) {
        const pendingIndex = pendingToolCallIds.indexOf(toolCallId);
        if (pendingIndex >= 0) {
          pendingToolCallIds.splice(pendingIndex, 1);
        }
      }
      messages.push(
        toolCallId
          ? {
              ...message,
              tool_call_id: toolCallId
            }
          : message
      );
      return;
    }
    messages.push(message);
  });

  const removedAssistantTurns = removedEmptyAssistantTurns + removedTemplateAssistantTurns;
  if (removedAssistantTurns <= 0) {
    return sanitized;
  }

  const metadata: typeof sanitized.metadata = {
    ...sanitized.metadata,
    chatProcessSanitizer: {
      removedAssistantTurns,
      removedEmptyAssistantTurns,
      removedTemplateAssistantTurns,
      removedToolTurns: 0,
      removedEmptyToolTurns: 0,
      removedOrphanToolTurns: 0,
      backfilledToolCallIds: 0
    }
  };

  return {
    ...sanitized,
    messages,
    metadata
  };
}
