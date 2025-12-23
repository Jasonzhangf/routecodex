import type { IncomingHttpHeaders } from 'http';

const CLAUDE_WARMUP_PATTERNS = [
  /claude[-\s]?code/i,
  /claude.*cli/i,
  /anthropic.*cli/i
];

export interface WarmupDetectionResult {
  isWarmup: boolean;
  userAgent?: string;
  reason?: string;
}

export function detectWarmupRequest(
  headers: IncomingHttpHeaders | undefined,
  payload: Record<string, unknown> | undefined
): WarmupDetectionResult {
  const userAgent = extractUserAgent(headers);
  if (!userAgent || !CLAUDE_WARMUP_PATTERNS.some((pattern) => pattern.test(userAgent))) {
    return { isWarmup: false, userAgent };
  }
  if (!payload) {
    return { isWarmup: false, userAgent };
  }
  const text = extractLastMessageText(payload)?.trim();
  const normalizedText = text?.toLowerCase();
  const isCountProbe = normalizedText === 'count';
  const isWarmupText = normalizedText === 'warmup' || (normalizedText ? normalizedText.endsWith('warmup') : false);
  if (!isCountProbe && !isWarmupText) {
    return { isWarmup: false, userAgent };
  }
  if (isCountProbe && !hasMaxTokensOne(payload)) {
    return { isWarmup: false, userAgent };
  }
  const reason = isCountProbe
    ? 'ua+count_probe'
    : 'ua+warmup_text';
  return { isWarmup: true, userAgent, reason };
}

function extractUserAgent(headers?: IncomingHttpHeaders): string | undefined {
  if (!headers) {
    return undefined;
  }
  const header = headers['user-agent'] || headers['User-Agent'];
  if (Array.isArray(header)) {
    return header[0];
  }
  return typeof header === 'string' ? header : undefined;
}

function hasMaxTokensOne(payload: Record<string, unknown>): boolean {
  const candidates = [
    payload.max_tokens,
    payload.maxTokens,
    payload.max_output_tokens,
    payload.maxOutputTokens,
    payload.parameters && typeof payload.parameters === 'object'
      ? (payload.parameters as Record<string, unknown>).max_tokens
      : undefined,
    payload.parameters && typeof payload.parameters === 'object'
      ? (payload.parameters as Record<string, unknown>).max_output_tokens
      : undefined
  ];
  for (const candidate of candidates) {
    const numberValue = normalizeNumber(candidate);
    if (numberValue === 1) {
      return true;
    }
  }
  return false;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractLastMessageText(payload: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
  if (messages && messages.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractContentText(messages[i]);
      if (text) {
        return text;
      }
    }
  }
  const input = Array.isArray(payload.input) ? payload.input : undefined;
  if (input && input.length) {
    for (let i = input.length - 1; i >= 0; i--) {
      const text = extractContentText(input[i]);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function extractContentText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const nested = content[i];
      const text = extractContentText(nested);
      if (text) {
        return text;
      }
    }
  } else if (content && typeof content === 'object') {
    const nestedRecord = content as Record<string, unknown>;
    if (typeof nestedRecord.text === 'string') {
      return nestedRecord.text;
    }
    if (typeof nestedRecord.content === 'string') {
      return nestedRecord.content;
    }
  }
  return undefined;
}
