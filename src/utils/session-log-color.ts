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
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash * 31) + normalized.charCodeAt(i)) >>> 0;
  }
  return SESSION_COLOR_PALETTE[hash % SESSION_COLOR_PALETTE.length];
}
