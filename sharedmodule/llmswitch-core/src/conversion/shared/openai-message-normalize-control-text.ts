import {
  readTrimmedString,
  type ToolHistoryContractViolation
} from './openai-message-normalize-contract.js';

const ROUTECODEX_LOCAL_ASSISTANT_PATTERNS: RegExp[] = [
  /^\[RouteCodex\]\s*request timed out before a response was received\b/i,
  /^\[RouteCodex\]\s*assistant response became empty after response sanitization\.?\s*$/i,
  /^\[RouteCodex\]\s*tool output was empty; execution status unknown\.?\s*$/i,
  /^\[RouteCodex\]\s*tool call result unknown\b/i
];

function isTextLikeContentPart(part: unknown): part is Record<string, unknown> {
  return Boolean(part && typeof part === 'object' && !Array.isArray(part));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractPlainTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const normalized = normalizeWhitespace(content);
    return normalized.length > 0 ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const fragments: string[] = [];
  for (const part of content) {
    if (!isTextLikeContentPart(part)) {
      return null;
    }
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof (part as Record<string, unknown>).input_text === 'string'
          ? String((part as Record<string, unknown>).input_text)
          : typeof (part as Record<string, unknown>).output_text === 'string'
            ? String((part as Record<string, unknown>).output_text)
            : typeof part.content === 'string'
              ? part.content
              : null;
    if (text === null) {
      return null;
    }
    const normalized = normalizeWhitespace(text);
    if (normalized.length > 0) {
      fragments.push(normalized);
    }
  }
  if (!fragments.length) {
    return null;
  }
  return fragments.join('\n');
}

function extractPlainTextFromValue(value: unknown): string | null {
  if (typeof value === 'string' || Array.isArray(value)) {
    return extractPlainTextFromContent(value);
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.text === 'string' || typeof row.content === 'string' || Array.isArray(row.content)) {
    return extractPlainTextFromContent(row.content ?? row.text);
  }
  if (typeof row.output_text === 'string') {
    return extractPlainTextFromContent(row.output_text);
  }
  if (typeof row.output === 'string' || Array.isArray(row.output)) {
    return extractPlainTextFromContent(row.output);
  }
  return null;
}

export function isSyntheticRouteCodexControlText(text: unknown): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const normalized = normalizeWhitespace(text);
  if (!normalized.startsWith('[RouteCodex]')) {
    return false;
  }
  return ROUTECODEX_LOCAL_ASSISTANT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSyntheticRouteCodexAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const role = typeof (message as { role?: unknown }).role === 'string'
    ? String((message as { role?: unknown }).role).trim().toLowerCase()
    : '';
  if (role !== 'assistant') {
    return false;
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return false;
  }
  const plainText = extractPlainTextFromContent((message as { content?: unknown }).content);
  return isSyntheticRouteCodexControlText(plainText);
}

export function inspectSyntheticRouteCodexAssistantMessages(messages: unknown): ToolHistoryContractViolation | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  for (const [index, message] of messages.entries()) {
    if (!isSyntheticRouteCodexAssistantMessage(message)) {
      continue;
    }
    const row = message as Record<string, unknown>;
    return {
      code: 'synthetic_local_control_text',
      index,
      role: readTrimmedString(row.role)?.toLowerCase(),
      itemType: 'message',
      reason: 'chat history contains synthetic RouteCodex local control text'
    };
  }
  return null;
}

function isSyntheticRouteCodexBridgeInputItem(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const item = entry as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    message?: { role?: unknown; content?: unknown } | null;
  };
  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (item.type === 'message' && role === 'assistant') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromContent(item.content));
  }
  if (item.type === 'message' && role === 'tool') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromValue(item.content));
  }
  if (
    item.type === 'function_call_output'
    || item.type === 'tool_result'
    || item.type === 'tool_message'
  ) {
    return isSyntheticRouteCodexControlText(
      extractPlainTextFromValue((item as { output?: unknown }).output ?? item.content)
    );
  }
  const nestedRole =
    item.message && typeof item.message.role === 'string'
      ? item.message.role.trim().toLowerCase()
      : '';
  if (nestedRole === 'assistant') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromContent(item.message?.content));
  }
  if (nestedRole === 'tool') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromValue(item.message?.content));
  }
  return false;
}

export function inspectSyntheticRouteCodexBridgeInput(input: unknown): ToolHistoryContractViolation | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  for (const [index, entry] of input.entries()) {
    if (!isSyntheticRouteCodexBridgeInputItem(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    return {
      code: 'synthetic_local_control_text',
      index,
      role: readTrimmedString(row.role)?.toLowerCase(),
      itemType: readTrimmedString(row.type)?.toLowerCase(),
      reason: 'bridge input contains synthetic RouteCodex local control text'
    };
  }
  return null;
}
