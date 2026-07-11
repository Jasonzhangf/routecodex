import { getSessionLogColorBinding } from '../modules/llmswitch/bridge/session-log-color-host.js';

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveSessionAnsiColor(sessionId?: unknown): string | undefined {
  const normalized = normalizeToken(sessionId);
  if (!normalized) {
    return undefined;
  }
  const fn = getSessionLogColorBinding().resolveSessionColorStr;
  if (typeof fn !== 'function') {
    throw new Error('[session-log-color] resolveSessionColorStr native export is required');
  }
  const parsed = JSON.parse(fn(normalized)) as unknown;
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
}

export function resolveSessionLogColorKey(context?: Record<string, unknown> | null): string | undefined {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }
  const fn = getSessionLogColorBinding().resolveSessionLogColorKeyJson;
  if (typeof fn !== 'function') {
    throw new Error('[session-log-color] resolveSessionLogColorKeyJson native export is required');
  }
  const raw = fn(JSON.stringify(context));
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'string') {
    return undefined;
  }
  return normalizeToken(parsed);
}
