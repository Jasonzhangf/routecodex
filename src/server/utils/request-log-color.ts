import { resolveEffectiveRequestId } from './request-id-manager.js';
import { resolveSessionAnsiColor } from '../../utils/session-log-color.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/;
const REQUEST_LOG_CONTEXT_TTL_MS = 30 * 60 * 1000;
const REQUEST_LOG_CONTEXT_MAX = 4096;

type RequestLogContextRecord = {
  sessionKey: string;
  expiresAtMs: number;
};

const REQUEST_LOG_CONTEXT = new Map<string, RequestLogContextRecord>();

function isConsoleColorEnabled(): boolean {
  const routecodexForceColor = String(
    process.env.ROUTECODEX_FORCE_LOG_COLOR
      ?? process.env.RCC_FORCE_LOG_COLOR
      ?? ''
  ).trim().toLowerCase();
  if (routecodexForceColor === '1' || routecodexForceColor === 'true' || routecodexForceColor === 'yes' || routecodexForceColor === 'on') {
    return true;
  }
  if (routecodexForceColor === '0' || routecodexForceColor === 'false' || routecodexForceColor === 'no' || routecodexForceColor === 'off') {
    return false;
  }
  const forceColor = String(process.env.FORCE_COLOR || '').trim();
  if (forceColor === '0') {
    return false;
  }
  if (forceColor.length > 0) {
    return true;
  }
  return true;
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

export function resolveSessionLogColor(sessionId?: string): string {
  return resolveSessionAnsiColor(sessionId) || '\x1b[36m';
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
    return resolveSessionAnsiColor(explicitSessionKey);
  }
  const requestKey = normalizeRequestKey(requestId);
  if (!requestKey) {
    return undefined;
  }
  const record = REQUEST_LOG_CONTEXT.get(requestKey);
  if (record && record.expiresAtMs > Date.now()) {
    return resolveSessionAnsiColor(record.sessionKey);
  }
  if (record) {
    REQUEST_LOG_CONTEXT.delete(requestKey);
  }
  return undefined;
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
