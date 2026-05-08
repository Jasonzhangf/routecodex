import type { JsonObject } from '../../../conversion/hub/types/json.js';
import { cloneJson } from '../../server-side-tools.js';

const TEXTUAL_TOOL_TRANSPORT_PATTERNS: RegExp[] = [
  /<\｜?DSML[\s\S]*tool_calls/i,
  /<\|DSML[\s\S]*tool_calls/i,
  /<function_calls?>/i,
  /<<\s*RCC_TOOL_CALLS(?:_JSON)?/i,
  /<tool_?call\b/i,
  /<invoke\b/i,
  /<use_mcp_tool\b/i
];

function readAssistantContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const text =
      typeof record.text === 'string'
        ? record.text.trim()
        : typeof record.output_text === 'string'
          ? record.output_text.trim()
          : typeof record.content === 'string'
            ? record.content.trim()
            : '';
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function hasStructuredToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

export function isTextualToolTransportOnlyAssistantMessage(message: Record<string, unknown>): boolean {
  if (hasStructuredToolCalls(message)) {
    return false;
  }
  const text = readAssistantContentText(message.content);
  if (!text) {
    return false;
  }
  return TEXTUAL_TOOL_TRANSPORT_PATTERNS.some((pattern) => pattern.test(text));
}

export function extractAssistantMessageFromChatLike(chatResponse: JsonObject): JsonObject | null {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return null;
  }
  const choices = Array.isArray((chatResponse as { choices?: unknown }).choices)
    ? ((chatResponse as { choices: unknown[] }).choices as unknown[])
    : [];
  if (choices.length > 0) {
    const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
      ? (choices[0] as Record<string, unknown>)
      : null;
    const msg =
      first &&
      first.message &&
      typeof first.message === 'object' &&
      !Array.isArray(first.message)
        ? (first.message as Record<string, unknown>)
        : null;
    if (msg) {
      if (isTextualToolTransportOnlyAssistantMessage(msg)) {
        return null;
      }
      return cloneJson(msg as JsonObject);
    }
  }
  const outputText = (chatResponse as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim().length) {
    return { role: 'assistant', content: outputText.trim() } as JsonObject;
  }
  return null;
}

export function buildToolMessagesFromToolOutputs(chatResponse: JsonObject): JsonObject[] {
  const toolOutputs = Array.isArray((chatResponse as { tool_outputs?: unknown }).tool_outputs)
    ? ((chatResponse as { tool_outputs: unknown[] }).tool_outputs as unknown[])
    : [];
  const messages: JsonObject[] = [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const toolCallId = typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined;
    if (!toolCallId) continue;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'tool';
    const rawContent = record.content;
    let contentText: string;
    if (typeof rawContent === 'string') {
      contentText = rawContent;
    } else {
      try {
        contentText = JSON.stringify(rawContent ?? {});
      } catch {
        contentText = String(rawContent ?? '');
      }
    }
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: contentText
    } as JsonObject);
  }
  return messages;
}

export function injectVisionSummaryIntoMessages(source: JsonObject[], summary: string): JsonObject[] {
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  let injected = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const nextParts: unknown[] = [];
    let removed = false;
    for (const part of content) {
      if (part && typeof part === 'object') {
        const typeValue = typeof (part as { type?: unknown }).type === 'string'
          ? String((part as { type?: unknown }).type).toLowerCase()
          : '';
        if (typeValue.includes('image')) {
          removed = true;
          nextParts.push({ type: 'text', text: '[Image omitted]' });
          continue;
        }
      }
      nextParts.push(part);
    }
    if (removed) {
      nextParts.push({ type: 'text', text: `[Vision] ${summary}` });
      (message as Record<string, unknown>).content = nextParts;
      injected = true;
    }
  }

  if (!injected) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof (msg as { role?: unknown }).role === 'string'
        ? String((msg as { role?: unknown }).role).toLowerCase()
        : '';
      if (role !== 'user') continue;
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        content.push({ type: 'text', text: `[Vision] ${summary}` });
        injected = true;
        break;
      }
      if (typeof content === 'string' && content.length) {
        (msg as Record<string, unknown>).content = `${content}\n[Vision] ${summary}`;
      } else {
        (msg as Record<string, unknown>).content = `[Vision] ${summary}`;
      }
      injected = true;
      break;
    }
  }

  if (!injected) {
    messages.push({ role: 'user', content: `[Vision] ${summary}` } as JsonObject);
  }
  return messages;
}

export function injectSystemTextIntoMessages(source: JsonObject[], text: string): JsonObject[] {
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  const content = typeof text === 'string' ? text : '';
  if (!content.trim().length) {
    return messages;
  }
  const sys: JsonObject = { role: 'system', content } as JsonObject;
  let insertAt = 0;
  while (insertAt < messages.length) {
    const msg = messages[insertAt];
    const role =
      msg && typeof msg === 'object' && !Array.isArray(msg) && typeof (msg as { role?: unknown }).role === 'string'
        ? String((msg as { role?: unknown }).role).trim().toLowerCase()
        : '';
    if (role === 'system') {
      insertAt += 1;
      continue;
    }
    break;
  }
  messages.splice(insertAt, 0, sys);
  return messages;
}

function compactToolContentValue(value: unknown, maxChars: number): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value ?? '');
          } catch {
            return String(value ?? '');
          }
        })();
  if (text.length <= maxChars) {
    return text;
  }
  const keepHead = Math.max(24, Math.floor(maxChars * 0.45));
  const keepTail = Math.max(24, Math.floor(maxChars * 0.35));
  const omitted = Math.max(0, text.length - keepHead - keepTail);
  const head = text.slice(0, keepHead);
  const tail = text.slice(text.length - keepTail);
  return head + '\n...[tool_output_compacted omitted=' + String(omitted) + ']...\n' + tail;
}

export function compactToolContentInMessages(source: JsonObject[], options: { maxChars: number }): JsonObject[] {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(64, Math.floor(options.maxChars)) : 1200;
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const role =
      typeof (message as { role?: unknown }).role === 'string'
        ? String((message as { role?: unknown }).role).trim().toLowerCase()
        : '';
    if (role !== 'tool') {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    (message as Record<string, unknown>).content = compactToolContentValue(content, maxChars);
  }
  return messages;
}
