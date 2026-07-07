import {
  resolveSessionColor,
  resolveSessionLogColorKey as resolveNativeSessionLogColorKey
} from 'rcc-llmswitch-core/v2/runtime/virtual-router-hit-log';

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
  return resolveSessionColor(normalized);
}

export function resolveSessionLogColorKey(context?: Record<string, unknown> | null): string | undefined {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }
  return resolveNativeSessionLogColorKey(context);
}
