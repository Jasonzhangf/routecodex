import { resolveEffectiveRequestId } from './request-id-manager.js';
import { resolveSessionAnsiColor, resolveSessionLogColorKey } from '../../utils/session-log-color.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/;
const ANSI_FALLBACK_LOG_COLOR = '\x1b[90m';
const ANSI_DEFAULT_NORMAL_LOG_COLOR = '\x1b[36m';
const ANSI_ERROR_LOG_COLOR = '\x1b[31m';
const REQUEST_LOG_CONTEXT_TTL_MS = 30 * 60 * 1000;
const REQUEST_LOG_CONTEXT_MAX = 4096;

type RequestLogContextRecord = {
  colorToken: string;
  colorSource: 'session' | 'request_default' | 'virtual_router_hit';
  expiresAtMs: number;
};

type RequestLogColorContext = Record<string, unknown>;

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

function resolveVirtualRouterHitRouteColor(text: string): string | undefined {
  const leadingColor = extractLeadingAnsiColor(text);
  if (leadingColor) {
    return leadingColor;
  }
  const markerColor = text.match(/(\x1b\[[0-9;]*m)\[virtual-router-hit\]/)?.[1];
  return markerColor || undefined;
}

function resolveVirtualRouterHitColorToken(text: string): string | undefined {
  const requestId = text.match(/\breq=([^ \x1b]+)/)?.[1];
  const requestKey = normalizeRequestKey(requestId);
  const routeColor = resolveVirtualRouterHitRouteColor(text);
  if (requestKey) {
    const record = REQUEST_LOG_CONTEXT.get(requestKey);
    if (record && record.expiresAtMs > Date.now()) {
      if (record.colorSource !== 'session' && routeColor) {
        const nextRecord: RequestLogContextRecord = {
          colorToken: routeColor,
          colorSource: 'virtual_router_hit',
          expiresAtMs: Date.now() + REQUEST_LOG_CONTEXT_TTL_MS
        };
        REQUEST_LOG_CONTEXT.set(requestKey, nextRecord);
        return nextRecord.colorToken;
      }
      return record.colorToken;
    }
    if (record) {
      REQUEST_LOG_CONTEXT.delete(requestKey);
    }
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
  return resolveSessionAnsiColor(sessionId) || '\x1b[36m';
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
  if (!requestKey || !context) {
    return;
  }
  const colorToken = sessionKey ? resolveSessionAnsiColor(sessionKey) : ANSI_DEFAULT_NORMAL_LOG_COLOR;
  if (!colorToken) {
    return;
  }
  const colorSource = sessionKey ? 'session' : 'request_default';
  const nowMs = Date.now();
  const existing = REQUEST_LOG_CONTEXT.get(requestKey);
  if (
    existing
    && existing.expiresAtMs > nowMs
    && existing.colorSource !== 'request_default'
    && colorSource === 'request_default'
  ) {
    REQUEST_LOG_CONTEXT.set(requestKey, {
      ...existing,
      expiresAtMs: nowMs + REQUEST_LOG_CONTEXT_TTL_MS
    });
    pruneExpiredContext(nowMs);
    return;
  }
  REQUEST_LOG_CONTEXT.set(requestKey, {
    colorToken,
    colorSource,
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
  const record = REQUEST_LOG_CONTEXT.get(requestKey);
  if (record && record.expiresAtMs > Date.now()) {
    return record.colorToken;
  }
  if (record) {
    REQUEST_LOG_CONTEXT.delete(requestKey);
  }
  return ANSI_DEFAULT_NORMAL_LOG_COLOR;
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
  const color = options?.isError ? ANSI_ERROR_LOG_COLOR : resolveRequestLogColorToken(requestId, context);
  if (!color) {
    return text;
  }
  if (text.startsWith(color) && text.endsWith(ANSI_RESET)) {
    return text;
  }
  return `${color}${stripAnsiCodes(text)}${ANSI_RESET}`;
}

export function colorizeVirtualRouterHitLogLine(text: string): string {
  if (!text || !text.includes('[virtual-router-hit]') || !isConsoleColorEnabled()) {
    return text;
  }
  const color = resolveVirtualRouterHitColorToken(text);
  if (!color) {
    return text;
  }
  return `${color}${stripAnsiCodes(text)}${ANSI_RESET}`;
}

export function formatHighlightedFinishReasonLabel(finishReason?: string): string {
  const normalized = typeof finishReason === 'string' ? finishReason.trim() : '';
  if (!normalized) {
    return '';
  }
  return `, finish_reason=${normalized}`;
}
