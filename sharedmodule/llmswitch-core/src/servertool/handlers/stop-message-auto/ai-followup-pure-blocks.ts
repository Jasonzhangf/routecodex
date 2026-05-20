/**
 * Shared pure text extraction functions from ai-followup.ts.
 *
 * Zero side effects. No env reads.
 * Deterministic input -> output for text extraction, sanitization,
 * and response snapshot analysis.
 */

import { sanitizeFollowupSnapshotText, sanitizeFollowupText } from '../followup-sanitize.js';
import { extractTextFromMessageContent } from './blocked-report.js';

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function hasStandaloneMarkerLine(text: string, marker: string): boolean {
  const content = typeof text === 'string' ? text.trim() : '';
  const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
  if (!content || !normalizedMarker) {
    return false;
  }
  const escapedMarker = normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*${escapedMarker}\\s*(?=\\n|$)`).test(content);
}

export function extractResponsesOutputText(base: { [key: string]: unknown }): string {
  const raw = (base as { output_text?: unknown }).output_text;
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const texts = raw
      .map((entry) => (typeof entry === 'string' ? entry : ''))
      .filter((entry) => entry.trim().length > 0);
    if (texts.length > 0) {
      return texts.join('\n').trim();
    }
  }
  const output = Array.isArray((base as { output?: unknown }).output) ? ((base as { output: unknown[] }).output) : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof (item as { type?: unknown }).type !== 'string') continue;
    const type = String((item as { type: unknown }).type).trim().toLowerCase();
    if (type.includes('tool') || type.includes('function') || type.includes('call')) {
      const toolText =
        extractUnknownText((item as { input?: unknown }).input) ||
        extractUnknownText((item as { arguments?: unknown }).arguments) ||
        extractUnknownText((item as { args?: unknown }).args) ||
        extractUnknownText((item as { patch?: unknown }).patch) ||
        extractUnknownText(item);
      if (toolText) {
        chunks.push(toolText);
      }
      continue;
    }
    if (type !== 'message') continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? ((item as { content: unknown[] }).content) : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const pType = typeof (part as { type?: unknown }).type === 'string'
        ? String((part as { type: unknown }).type).trim().toLowerCase()
        : '';
      if (pType === 'output_text' || pType === 'text' || pType === 'input_text') {
        const text = typeof (part as { text?: unknown }).text === 'string' ? String((part as { text: unknown }).text) : '';
        if (text.trim().length) chunks.push(text.trim());
        continue;
      }
      const extractedText =
        extractUnknownText((part as { text?: unknown }).text) ||
        extractUnknownText((part as { input?: unknown }).input) ||
        extractUnknownText((part as { arguments?: unknown }).arguments) ||
        extractUnknownText((part as { args?: unknown }).args) ||
        extractUnknownText((part as { patch?: unknown }).patch) ||
        extractUnknownText((part as { content?: unknown }).content) ||
        extractUnknownText((part as { value?: unknown }).value);
      if (extractedText) {
        chunks.push(extractedText);
      }
    }
  }
  return chunks.join('\n').trim();
}

export function hasToolLikeOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const typeRaw = (value as { type?: unknown }).type;
  const type = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : '';
  if (!type) {
    return false;
  }
  return (
    type === 'tool_call' ||
    type === 'tool_use' ||
    type === 'function_call' ||
    type.includes('tool')
  );
}

export function normalizeCodexProfileToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase() === 'default' ? undefined : trimmed;
}

export function sanitizeStopMessageAutoMessageOutput(raw: unknown, maxChars: number): string {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return '';
  }
  const withoutAnsi = text.replace(ANSI_ESCAPE_PATTERN, '');
  const withoutCodeFence = withoutAnsi
    .replace(/^```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/\s*```$/g, '');
  const cleaned = withoutCodeFence.trim();
  if (!cleaned) {
    return '';
  }
  const sanitized = sanitizeFollowupText(cleaned);
  if (!sanitized) {
    return '';
  }
  return sanitized.length > maxChars ? sanitized.slice(0, maxChars).trim() : sanitized;
}

export function truncateStopMessageAutoMessagePrompt(value: string, maxChars: number): string {
  const text = sanitizeFollowupSnapshotText(value);
  if (!text) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

export function summarizeStopMessageAutoMessageLog(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) {
    return '';
  }
  const singleLine = text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
}

export function extractStopMessageAssistantText(message: Record<string, unknown>): string {
  const chunks: string[] = [];
  const contentText = extractTextFromMessageContent(message.content);
  if (contentText) {
    chunks.push(contentText);
  }
  const directKeys = [
    'text',
    'output_text',
    'response',
    'summary',
    'message',
    'result',
    'command',
    'patch'
  ];
  for (const key of directKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }
  const toolLikeKeys = [
    'tool_calls',
    'tool_call',
    'function_call',
    'tool_use',
    'input',
    'arguments',
    'args',
    'payload'
  ];
  for (const key of toolLikeKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }
  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

export function extractStopMessageReasoningText(message: Record<string, unknown>): string {
  const explicitKeys = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'thinking',
    'thought',
    'analysis'
  ];
  const chunks: string[] = [];
  for (const key of explicitKeys) {
    const text = extractUnknownText(message[key]);
    if (text) {
      chunks.push(text);
    }
  }

  const contentReasoning = extractStopMessageReasoningFromContent(message.content);
  if (contentReasoning) {
    chunks.push(contentReasoning);
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

export function extractResponsesReasoningText(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  const directReasoning = extractUnknownText(payload.reasoning);
  if (directReasoning) {
    chunks.push(directReasoning);
  }

  const output = Array.isArray(payload.output) ? (payload.output as unknown[]) : [];
  for (const item of output) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const type = toNonEmptyText(record.type).toLowerCase();
    if (type.includes('reason') || type.includes('think') || type.includes('analysis')) {
      const text = extractUnknownText(record.summary) || extractUnknownText(record.content) || extractUnknownText(record.text);
      if (text) {
        chunks.push(text);
      }
      continue;
    }
    if (type === 'message') {
      const contentReasoning = extractStopMessageReasoningFromContent(record.content);
      if (contentReasoning) {
        chunks.push(contentReasoning);
      }
    }
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

export function extractStopMessageReasoningFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const chunks: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const type = toNonEmptyText(record.type).toLowerCase();
    if (!type.includes('reason') && !type.includes('think') && !type.includes('analysis')) {
      continue;
    }
    const text =
      extractUnknownText(record.text) ||
      extractUnknownText(record.summary) ||
      extractUnknownText(record.content) ||
      extractUnknownText(record.value);
    if (text) {
      chunks.push(text);
    }
  }
  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(chunks));
}

export function extractUnknownText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return sanitizeFollowupSnapshotText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return sanitizeFollowupSnapshotText(String(value));
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractUnknownText(entry, depth + 1))
      .filter((entry) => entry.length > 0);
    return dedupeAndJoinTexts(parts);
  }
  if (typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const priorityKeys = [
    'text',
    'content',
    'value',
    'summary',
    'reasoning',
    'thinking',
    'analysis',
    'function',
    'input',
    'arguments',
    'args',
    'patch',
    'payload',
    'result',
    'command',
    'message',
    'output_text',
    'name'
  ];
  const parts: string[] = [];
  for (const key of priorityKeys) {
    if (!(key in record)) {
      continue;
    }
    const text = extractUnknownText(record[key], depth + 1);
    if (text) {
      parts.push(text);
    }
  }

  if (parts.length === 0) {
    for (const raw of Object.values(record)) {
      if (typeof raw !== 'string') {
        continue;
      }
      const text = raw.trim();
      if (text) {
        parts.push(text);
      }
    }
  }

  return sanitizeFollowupSnapshotText(dedupeAndJoinTexts(parts));
}

export function dedupeAndJoinTexts(parts: string[]): string {
  const unique = Array.from(
    new Set(
      parts
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    )
  );
  return sanitizeFollowupSnapshotText(unique.join('\n').trim());
}

export function buildStopMessageResponseExcerpt(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    if (!raw) {
      return '';
    }
    if (raw.length <= 3_000) {
      return sanitizeFollowupSnapshotText(raw);
    }
    return sanitizeFollowupSnapshotText(`${raw.slice(0, 3_000)}...`);
  } catch {
    return '';
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function toNonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

