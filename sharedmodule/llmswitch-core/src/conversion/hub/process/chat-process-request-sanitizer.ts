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
  const rows = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  const parts: string[] = [];
  for (const item of rows) {
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
    const directKeys = ['text', 'output_text', 'input_text', 'content', 'thinking', 'reasoning', 'reasoning_content'] as const;
    for (const key of directKeys) {
      const text = readNonEmptyString(row[key]);
      if (text) {
        parts.push(text);
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

function isMeaninglessDotOnlyText(text: string): boolean {
  const normalized = text.trim();
  return normalized === '.' || normalized === '..' || normalized === '...';
}

function messageContainsBlockType(content: unknown, type: string): boolean {
  const rows = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const blockType = readNonEmptyString((item as Record<string, unknown>).type)?.toLowerCase();
    if (blockType === type) {
      return true;
    }
  }
  return false;
}

function readAssistantMirrorTexts(message: StandardizedMessage): { text: string; reasoningText: string } | null {
  const messageRecord = message as unknown as Record<string, unknown>;
  const text = extractMessageText(message.content);
  const reasoningText = extractMessageText(
    messageRecord.reasoning_content ?? messageRecord.reasoningContent ?? messageRecord.reasoning
  );
  const normalizedText = isMeaninglessDotOnlyText(text) ? '' : text;
  const normalizedReasoningText = isMeaninglessDotOnlyText(reasoningText) ? '' : reasoningText;
  if (!normalizedText || !normalizedReasoningText) {
    return null;
  }
  return {
    text: normalizedText,
    reasoningText: normalizedReasoningText
  };
}

function isAssistantMirrorTurn(message: StandardizedMessage): boolean {
  const texts = readAssistantMirrorTexts(message);
  return Boolean(texts && texts.text === texts.reasoningText);
}

function isStructuredToolBoundaryMessage(message: StandardizedMessage): boolean {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const role = typeof message.role === 'string' ? message.role.toLowerCase().trim() : '';
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  if (role === 'assistant' && messageContainsBlockType(message.content, 'tool_use')) {
    return true;
  }
  if ((role === 'user' || role === 'tool') && messageContainsBlockType(message.content, 'tool_result')) {
    return true;
  }
  return role === 'tool';
}

function collectDuplicateMirrorAssistantIndices(messages: StandardizedMessage[]): Set<number> {
  const duplicateIndices = new Set<number>();
  let hasBoundary = false;
  let segmentMirrorIndices: number[] = [];

  const flushSegment = () => {
    if (segmentMirrorIndices.length >= 2) {
      for (const index of segmentMirrorIndices) {
        duplicateIndices.add(index);
      }
    }
    segmentMirrorIndices = [];
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }
    if (isStructuredToolBoundaryMessage(message)) {
      hasBoundary = true;
      flushSegment();
      continue;
    }
    if (!hasBoundary) {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role.toLowerCase().trim() : '';
    if (role === 'assistant' && isAssistantMirrorTurn(message)) {
      segmentMirrorIndices.push(index);
    }
  }

  flushSegment();
  return duplicateIndices;
}

export function sanitizeChatProcessRequest(
  request: StandardizedRequest
): StandardizedRequest {
  const sanitized = stripGenericMarkersFromRequest(request);
  if (!Array.isArray(sanitized.messages) || !sanitized.messages.length) {
    return sanitized;
  }

  const duplicateMirrorAssistantIndices = collectDuplicateMirrorAssistantIndices(
    sanitized.messages as StandardizedMessage[]
  );

  let removedEmptyAssistantTurns = 0;
  let removedTemplateAssistantTurns = 0;
  let removedDuplicateMirrorAssistantTurns = 0;
  let didMutateMessageShapes = false;
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
        didMutateMessageShapes = true;
        messages.push({
          ...message,
          tool_calls: normalized
        });
        return;
      }
      if (messageContainsBlockType(message.content, 'tool_use')) {
        messages.push(message);
        return;
      }
      const mirrorTexts = readAssistantMirrorTexts(message);
      const normalizedText = mirrorTexts?.text ?? (() => {
        const text = extractMessageText(message.content);
        return isMeaninglessDotOnlyText(text) ? '' : text;
      })();
      const normalizedReasoningText = mirrorTexts?.reasoningText ?? (() => {
        const messageRecord = message as unknown as Record<string, unknown>;
        const reasoningText = extractMessageText(
          messageRecord.reasoning_content ?? messageRecord.reasoningContent ?? messageRecord.reasoning
        );
        return isMeaninglessDotOnlyText(reasoningText) ? '' : reasoningText;
      })();
      if (!normalizedText && !normalizedReasoningText) {
        removedEmptyAssistantTurns += 1;
        return;
      }
      if (isTemplateAssistantText(normalizedText)) {
        removedTemplateAssistantTurns += 1;
        return;
      }
      if (duplicateMirrorAssistantIndices.has(index)) {
        removedDuplicateMirrorAssistantTurns += 1;
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
      if (toolCallId && message.tool_call_id !== toolCallId) {
        didMutateMessageShapes = true;
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

  const removedAssistantTurns =
    removedEmptyAssistantTurns
    + removedTemplateAssistantTurns
    + removedDuplicateMirrorAssistantTurns;
  if (removedAssistantTurns <= 0 && !didMutateMessageShapes) {
    return sanitized;
  }

  const nextRequest: StandardizedRequest = {
    ...sanitized,
    messages
  };
  if (removedAssistantTurns > 0) {
    nextRequest.metadata = {
      ...sanitized.metadata,
      chatProcessSanitizer: {
        removedAssistantTurns,
        removedEmptyAssistantTurns,
        removedTemplateAssistantTurns,
        removedDuplicateMirrorAssistantTurns,
        removedToolTurns: 0,
        removedEmptyToolTurns: 0,
        removedOrphanToolTurns: 0,
        backfilledToolCallIds: 0
      }
    };
  }
  return nextRequest;
}
