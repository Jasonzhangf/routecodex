import {
  resolveSessionColor,
  resolveSessionLogColorKey as resolveSharedSessionLogColorKey
} from '../../sharedmodule/llmswitch-core/dist/runtime/virtual-router-hit-log.js';

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
  return resolveSharedSessionLogColorKey(context);
}
