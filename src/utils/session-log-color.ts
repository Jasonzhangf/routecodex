const SESSION_COLOR_PALETTE = [
  '\x1b[31m',
  '\x1b[32m',
  '\x1b[33m',
  '\x1b[34m',
  '\x1b[35m',
  '\x1b[36m',
  '\x1b[91m',
  '\x1b[92m',
  '\x1b[93m',
  '\x1b[94m',
  '\x1b[95m',
  '\x1b[96m',
  '\x1b[38;5;202m',
  '\x1b[38;5;208m',
  '\x1b[38;5;214m',
  '\x1b[38;5;220m',
  '\x1b[38;5;45m',
  '\x1b[38;5;51m',
  '\x1b[38;5;39m',
  '\x1b[38;5;75m',
  '\x1b[38;5;141m',
  '\x1b[38;5;177m',
  '\x1b[38;5;171m',
  '\x1b[38;5;207m'
] as const;

function hashSessionToken(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

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
  const hash = hashSessionToken(normalized);
  return SESSION_COLOR_PALETTE[hash % SESSION_COLOR_PALETTE.length];
}
