/**
 * Stopless directive parsing utilities.
 * Extracted from reasoning-stop-state.ts for file size limits.
 */

import { extractCapturedChatSeed } from './followup-request-builder.js';

export type ReasoningStopMode = 'on' | 'off' | 'endless';

const STOPLESS_DIRECTIVE_PATTERN = /<\*\*stopless:([a-z0-9_-]+)\*\*>/gi;
const STOPLESS_DIRECTIVE_STRIP_PATTERN = /<\*\*stopless:[^*]+\*\*>/gi;

const REASONING_STOP_DIRECTIVE_MODE_KEYS = [
  'reasoningStopDirectiveMode',
  '__reasoningStopDirectiveMode'
] as const;

export function normalizeReasoningStopMode(value: unknown): ReasoningStopMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'endless') {
    return normalized;
  }
  return undefined;
}

function readStoredReasoningStopDirectiveMode(source: unknown): ReasoningStopMode | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  for (const key of REASONING_STOP_DIRECTIVE_MODE_KEYS) {
    const mode = normalizeReasoningStopMode(record[key]);
    if (mode) {
      return mode;
    }
  }
  return undefined;
}

function storeReasoningStopDirectiveMode(source: unknown, mode: ReasoningStopMode | undefined): void {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !mode) {
    return;
  }
  const record = source as Record<string, unknown>;
  for (const key of REASONING_STOP_DIRECTIVE_MODE_KEYS) {
    record[key] = mode;
  }
}

function extractMessageContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (text) {
        parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function extractLatestUserTextFromCapturedRequest(source: unknown): string {
  const seed = extractCapturedChatSeed(source);
  if (!seed || !Array.isArray(seed.messages) || seed.messages.length === 0) {
    return '';
  }
  for (let i = seed.messages.length - 1; i >= 0; i -= 1) {
    const msg = seed.messages[i];
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    const role = typeof (msg as Record<string, unknown>).role === 'string'
      ? String((msg as Record<string, unknown>).role).trim().toLowerCase()
      : '';
    if (role !== 'user') {
      continue;
    }
    const content = (msg as Record<string, unknown>).content;
    const text = extractMessageContentText(content);
    if (text) {
      return text;
    }
  }
  return '';
}

function extractStoplessDirectiveModeFromText(text: string): ReasoningStopMode | undefined {
  const source = typeof text === 'string' ? text : '';
  if (!source) {
    return undefined;
  }
  STOPLESS_DIRECTIVE_PATTERN.lastIndex = 0;
  let matched: ReasoningStopMode | undefined;
  for (const match of source.matchAll(STOPLESS_DIRECTIVE_PATTERN)) {
    const mode = normalizeReasoningStopMode(match[1]);
    if (mode) {
      matched = mode;
    }
  }
  return matched;
}

function stripStoplessDirectiveMarkersFromText(text: string): { text: string; stripped: boolean } {
  if (typeof text !== 'string' || !text) {
    return { text: '', stripped: false };
  }
  let stripped = false;
  STOPLESS_DIRECTIVE_STRIP_PATTERN.lastIndex = 0;
  const replaced = text.replace(STOPLESS_DIRECTIVE_STRIP_PATTERN, () => {
    stripped = true;
    return ' ';
  });
  if (!stripped) {
    return { text, stripped: false };
  }
  const compacted = replaced
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: compacted, stripped: true };
}

function stripStoplessDirectiveMarkersFromContent(content: unknown): {
  content: unknown;
  stripped: boolean;
} {
  if (typeof content === 'string') {
    const stripped = stripStoplessDirectiveMarkersFromText(content);
    return { content: stripped.text, stripped: stripped.stripped };
  }
  if (!Array.isArray(content)) {
    return { content, stripped: false };
  }
  const nextContent: unknown[] = [];
  let strippedAny = false;
  for (const item of content) {
    if (typeof item === 'string') {
      const stripped = stripStoplessDirectiveMarkersFromText(item);
      if (stripped.stripped) {
        strippedAny = true;
      }
      nextContent.push(stripped.text);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      nextContent.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string') {
      nextContent.push(item);
      continue;
    }
    const stripped = stripStoplessDirectiveMarkersFromText(record.text);
    if (!stripped.stripped) {
      nextContent.push(item);
      continue;
    }
    strippedAny = true;
    nextContent.push({
      ...record,
      text: stripped.text
    });
  }
  return {
    content: nextContent,
    stripped: strippedAny
  };
}

function stripStoplessDirectiveMarkersInMessages(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  let strippedAny = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const role = typeof (message as Record<string, unknown>).role === 'string'
      ? String((message as Record<string, unknown>).role).trim().toLowerCase()
      : '';
    if (role !== 'user') {
      continue;
    }
    const originalContent = (message as Record<string, unknown>).content;
    const stripped = stripStoplessDirectiveMarkersFromContent(originalContent);
    if (!stripped.stripped) {
      continue;
    }
    strippedAny = true;
    (message as Record<string, unknown>).content = stripped.content;
  }
  return strippedAny;
}

function stripStoplessDirectiveMarkersFromCapturedRequest(source: unknown): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return false;
  }
  const record = source as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? (record.messages as unknown[]) : [];
  const input = Array.isArray(record.input) ? (record.input as unknown[]) : [];
  const strippedInMessages = stripStoplessDirectiveMarkersInMessages(messages);
  const strippedInInput = stripStoplessDirectiveMarkersInMessages(input);
  return strippedInMessages || strippedInInput;
}

export function extractStoplessDirectiveModeFromAdapterContext(adapterContext: unknown): ReasoningStopMode | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const captured = record.capturedChatRequest;
  const storedMode = readStoredReasoningStopDirectiveMode(captured) ?? readStoredReasoningStopDirectiveMode(record);
  if (storedMode) {
    return storedMode;
  }
  const text = extractLatestUserTextFromCapturedRequest(captured);
  const mode = extractStoplessDirectiveModeFromText(text);
  if (mode) {
    storeReasoningStopDirectiveMode(record, mode);
    storeReasoningStopDirectiveMode(captured, mode);
  }
  // Marker is transport control signal and must never leak into followup payloads,
  // regardless of whether parsing succeeds.
  stripStoplessDirectiveMarkersFromCapturedRequest(captured);
  return mode;
}
