import { resolveEffectiveRequestId } from './request-id-manager.js';
import { resolveSessionAnsiColor, resolveSessionLogColorKey } from '../../utils/session-log-color.js';
import { highlightImportantLogFields } from './http-log-code-color.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_ERROR_LOG_COLOR = '\x1b[31m';
const REQUEST_LOG_CONTEXT_TTL_MS = 30 * 60 * 1000;
const REQUEST_LOG_CONTEXT_MAX = 4096;
const REQUEST_LOG_CONTEXT_GLOBAL_KEY = Symbol.for('routecodex.requestLogColorContext.v1');

type RequestLogContextRecord = {
  colorToken: string;
  expiresAtMs: number;
};

type RequestLogColorContext = Record<string, unknown>;

const requestLogContextGlobal = globalThis as typeof globalThis & {
  [REQUEST_LOG_CONTEXT_GLOBAL_KEY]?: Map<string, RequestLogContextRecord>;
};
const REQUEST_LOG_CONTEXT =
  requestLogContextGlobal[REQUEST_LOG_CONTEXT_GLOBAL_KEY]
  ?? new Map<string, RequestLogContextRecord>();
requestLogContextGlobal[REQUEST_LOG_CONTEXT_GLOBAL_KEY] = REQUEST_LOG_CONTEXT;

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

function resolveSessionKey(context?: RequestLogColorContext | null): string | undefined {
  return resolveSessionLogColorKey(context);
}

function resolveVirtualRouterHitSessionKey(text: string): string | undefined {
  const bracketSession = text.match(/\[virtual-router-hit\](?:\x1b\[[0-9;]*m)?\s+\[([^\]\x1b]+)\]/)?.[1];
  if (bracketSession) {
    return normalizeToken(bracketSession);
  }
  const sid = text.match(/\bsid=([^ \x1b]+)/)?.[1];
  return normalizeToken(sid);
}

function resolveVirtualRouterHitRequestKey(text: string): string | undefined {
  const requestId = text.match(/\breq=([^ \x1b]+)/)?.[1];
  return normalizeRequestKey(requestId);
}

function normalizeInlineRequestToken(value: string | undefined): string | undefined {
  return normalizeRequestKey(value?.replace(/[,"'}\])]+$/g, ''));
}

function resolveRequestScopedLogLineRequestKey(text: string): string | undefined {
  const patterns = [
    /\brequest=([^ \x1b,)}\]]+)/,
    /\brequestId["']?\s*[:=]\s*["']?([^"'\s,)}\]]+)/,
    /["']requestId["']\s*:\s*["']([^"']+)["']/,
    /\brequest\s+([^ \x1b]+)\s+(?:started|completed|failed)\b/,
    /\breq=([^ \x1b,)}\]]+)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const requestKey = normalizeInlineRequestToken(match?.[1]);
    if (requestKey) {
      return requestKey;
    }
  }
  return undefined;
}

function resolveRegisteredRequestColorToken(requestKey: string | undefined): string | undefined {
  if (!requestKey) {
    return undefined;
  }
  const record = REQUEST_LOG_CONTEXT.get(requestKey);
  if (record && record.expiresAtMs > Date.now()) {
    return record.colorToken;
  }
  if (record) {
    REQUEST_LOG_CONTEXT.delete(requestKey);
  }
  return undefined;
}

function resolveVirtualRouterHitColorToken(text: string): string | undefined {
  const requestColor = resolveRegisteredRequestColorToken(resolveVirtualRouterHitRequestKey(text));
  if (requestColor) {
    return requestColor;
  }
  const sessionKey = resolveVirtualRouterHitSessionKey(text);
  return sessionKey ? resolveSessionAnsiColor(sessionKey) : undefined;
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
  return resolveSessionAnsiColor(sessionId) || '';
}

export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function extractLeadingAnsiColor(text: string): string | undefined {
  const match = /^(\x1b\[[0-9;]*m)/.exec(text);
  return match?.[1];
}

export function registerRequestLogContext(
  requestId: string | undefined,
  context?: RequestLogColorContext | null
): void {
  const requestKey = normalizeRequestKey(requestId);
  const sessionKey = resolveSessionKey(context);
  if (!requestKey || !context || !sessionKey) {
    return;
  }
  const colorToken = resolveSessionAnsiColor(sessionKey);
  if (!colorToken) {
    return;
  }
  const nowMs = Date.now();
  REQUEST_LOG_CONTEXT.set(requestKey, {
    colorToken,
    expiresAtMs: nowMs + REQUEST_LOG_CONTEXT_TTL_MS
  });
  pruneExpiredContext(nowMs);
}

export function resolveRequestLogColorToken(
  requestId?: string,
  context?: RequestLogColorContext | null
): string | undefined {
  const explicitSessionKey = resolveSessionKey(context);
  if (explicitSessionKey) {
    return resolveSessionAnsiColor(explicitSessionKey);
  }
  const requestKey = normalizeRequestKey(requestId);
  if (!requestKey) {
    return undefined;
  }
  return resolveRegisteredRequestColorToken(requestKey);
}

export function colorizeRequestLog(
  text: string,
  requestId?: string,
  context?: RequestLogColorContext | null,
  options?: { isError?: boolean }
): string {
  if (!text || !isConsoleColorEnabled()) {
    return text;
  }
  const requestColor = resolveRequestLogColorToken(requestId, context);
  const color = requestColor ?? (options?.isError ? ANSI_ERROR_LOG_COLOR : undefined);
  if (!color) {
    return highlightImportantLogFields(text);
  }
  if (text.startsWith(color) && text.endsWith(ANSI_RESET)) {
    return highlightImportantLogFields(text, color);
  }
  return `${color}${highlightImportantLogFields(stripAnsiCodes(text), color)}${ANSI_RESET}`;
}

export function colorizeVirtualRouterHitLogLine(text: string): string {
  if (!text || !text.includes('[virtual-router-hit]') || !isConsoleColorEnabled()) {
    return text;
  }
  const color = resolveVirtualRouterHitColorToken(text);
  if (!color) {
    return highlightImportantLogFields(text);
  }
  return `${color}${highlightImportantLogFields(stripAnsiCodes(text), color)}${ANSI_RESET}`;
}

export function colorizeRequestScopedLogLine(text: string): string {
  if (!text || !isConsoleColorEnabled()) {
    return text;
  }
  const virtualRouterHitLine = colorizeVirtualRouterHitLogLine(text);
  if (virtualRouterHitLine !== text) {
    return virtualRouterHitLine;
  }
  const color = resolveRegisteredRequestColorToken(resolveRequestScopedLogLineRequestKey(text));
  if (!color) {
    return highlightImportantLogFields(text);
  }
  if (text.startsWith(color) && text.endsWith(ANSI_RESET)) {
    return highlightImportantLogFields(text, color);
  }
  return `${color}${highlightImportantLogFields(stripAnsiCodes(text), color)}${ANSI_RESET}`;
}

export function formatHighlightedFinishReasonLabel(finishReason?: string): string {
  const normalized = typeof finishReason === 'string' ? finishReason.trim() : '';
  if (!normalized) {
    return '';
  }
  return `, finish_reason=${normalized}`;
}
