import { resolveEffectiveRequestId } from './request-id-manager.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/;
const SESSION_COLOR_PALETTE = [
  '\x1b[31m',
  '\x1b[32m',
  '\x1b[33m',
  '\x1b[34m',
  '\x1b[35m',
  '\x1b[36m',
  '\x1b[38;5;208m',
  '\x1b[38;5;141m'
] as const;
const REQUEST_LOG_CONTEXT_TTL_MS = 30 * 60 * 1000;
const REQUEST_LOG_CONTEXT_MAX = 4096;

type RequestLogContextRecord = {
  sessionKey: string;
  expiresAtMs: number;
};

const REQUEST_LOG_CONTEXT = new Map<string, RequestLogContextRecord>();

function isConsoleColorEnabled(): boolean {
  if (String(process.env.NO_COLOR || '').trim()) {
    return false;
  }
  const forceColor = String(process.env.FORCE_COLOR || '').trim();
  if (forceColor === '0') {
    return false;
  }
  return process.stdout?.isTTY === true;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequestKey(requestId?: string): string | undefined {
  const resolved = normalizeToken(resolveEffectiveRequestId(requestId));
  if (!resolved || resolved === 'unknown' || resolved.includes('-unknown-')) {
    return undefined;
  }
  const delimiterIndex = resolved.indexOf(':');
  return delimiterIndex >= 0 ? resolved.slice(0, delimiterIndex) : resolved;
}

function resolveSessionKey(context?: {
  sessionId?: unknown;
  conversationId?: unknown;
}): string | undefined {
  return normalizeToken(context?.sessionId) || normalizeToken(context?.conversationId);
}

function pruneExpiredContext(nowMs: number): void {
  for (const [key, record] of REQUEST_LOG_CONTEXT.entries()) {
    if (record.expiresAtMs <= nowMs) {
      REQUEST_LOG_CONTEXT.delete(key);
    }
  }
  while (REQUEST_LOG_CONTEXT.size > REQUEST_LOG_CONTEXT_MAX) {
    const oldestKey = REQUEST_LOG_CONTEXT.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    REQUEST_LOG_CONTEXT.delete(oldestKey);
  }
}

function hashColorKey(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
  }
  return SESSION_COLOR_PALETTE[hash % SESSION_COLOR_PALETTE.length];
}

export function resolveSessionLogColor(sessionId?: string): string {
  const normalized = normalizeToken(sessionId);
  if (!normalized) {
    return '\x1b[36m';
  }
  return hashColorKey(normalized);
}

export function registerRequestLogContext(
  requestId: string | undefined,
  context?: { sessionId?: unknown; conversationId?: unknown }
): void {
  const requestKey = normalizeRequestKey(requestId);
  const sessionKey = resolveSessionKey(context);
  if (!requestKey || !sessionKey) {
    return;
  }
  const nowMs = Date.now();
  REQUEST_LOG_CONTEXT.set(requestKey, {
    sessionKey,
    expiresAtMs: nowMs + REQUEST_LOG_CONTEXT_TTL_MS
  });
  pruneExpiredContext(nowMs);
}

export function resolveRequestLogColorToken(
  requestId?: string,
  context?: { sessionId?: unknown; conversationId?: unknown }
): string | undefined {
  const explicitSessionKey = resolveSessionKey(context);
  if (explicitSessionKey) {
    return hashColorKey(explicitSessionKey);
  }
  const requestKey = normalizeRequestKey(requestId);
  if (!requestKey) {
    return undefined;
  }
  const record = REQUEST_LOG_CONTEXT.get(requestKey);
  if (record && record.expiresAtMs > Date.now()) {
    return hashColorKey(record.sessionKey);
  }
  if (record) {
    REQUEST_LOG_CONTEXT.delete(requestKey);
  }
  return hashColorKey(requestKey);
}

export function colorizeRequestLog(
  text: string,
  requestId?: string,
  context?: { sessionId?: unknown; conversationId?: unknown }
): string {
  if (!text || !isConsoleColorEnabled() || ANSI_PATTERN.test(text)) {
    return text;
  }
  const color = resolveRequestLogColorToken(requestId, context);
  if (!color) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

