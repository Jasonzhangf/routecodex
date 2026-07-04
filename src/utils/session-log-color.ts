const SESSION_LOG_COLOR_PALETTE = [
  '\x1b[32m',
  '\x1b[33m',
  '\x1b[34m',
  '\x1b[35m',
  '\x1b[36m',
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
  '\x1b[38;5;207m',
  '\x1b[38;5;27m',
  '\x1b[38;5;33m',
  '\x1b[38;5;57m',
  '\x1b[38;5;63m',
  '\x1b[38;5;69m',
  '\x1b[38;5;81m',
  '\x1b[38;5;82m',
  '\x1b[38;5;83m',
  '\x1b[38;5;84m',
  '\x1b[38;5;85m',
  '\x1b[38;5;86m',
  '\x1b[38;5;87m',
  '\x1b[38;5;99m',
  '\x1b[38;5;105m',
  '\x1b[38;5;111m',
  '\x1b[38;5;117m',
  '\x1b[38;5;118m',
  '\x1b[38;5;119m',
  '\x1b[38;5;120m',
  '\x1b[38;5;121m',
  '\x1b[38;5;122m',
  '\x1b[38;5;123m',
  '\x1b[38;5;129m',
  '\x1b[38;5;135m',
  '\x1b[38;5;147m',
  '\x1b[38;5;153m',
  '\x1b[38;5;154m',
  '\x1b[38;5;155m',
  '\x1b[38;5;156m',
  '\x1b[38;5;157m',
  '\x1b[38;5;158m',
  '\x1b[38;5;159m',
  '\x1b[38;5;165m',
  '\x1b[38;5;183m'
] as const;
const SESSION_LOG_COLOR_ASSIGNMENTS = new Map<string, string>();
const SESSION_LOG_COLOR_USAGE = new Map<string, string>();

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hashSessionLogColorToken(value: string): number {
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

export function resolveSessionAnsiColor(sessionId?: unknown): string | undefined {
  const normalized = normalizeToken(sessionId);
  if (!normalized) {
    return undefined;
  }
  const assigned = SESSION_LOG_COLOR_ASSIGNMENTS.get(normalized);
  if (assigned) {
    return assigned;
  }
  const hash = hashSessionLogColorToken(normalized);
  const startIndex = hash % SESSION_LOG_COLOR_PALETTE.length;
  for (let offset = 0; offset < SESSION_LOG_COLOR_PALETTE.length; offset += 1) {
    const color = SESSION_LOG_COLOR_PALETTE[(startIndex + offset) % SESSION_LOG_COLOR_PALETTE.length];
    if (!SESSION_LOG_COLOR_USAGE.has(color)) {
      SESSION_LOG_COLOR_ASSIGNMENTS.set(normalized, color);
      SESSION_LOG_COLOR_USAGE.set(color, normalized);
      return color;
    }
  }
  const color = SESSION_LOG_COLOR_PALETTE[startIndex];
  SESSION_LOG_COLOR_ASSIGNMENTS.set(normalized, color);
  return color;
}

export function resolveSessionLogColorKey(context?: Record<string, unknown> | null): string | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }
  const candidates = [
    context.logSessionColorKey,
    context.sessionId,
    context.session_id,
    context.conversationId,
    context.conversation_id,
    context.clientTmuxSessionId,
    context.client_tmux_session_id,
    context.tmuxSessionId,
    context.tmux_session_id,
    context.rccSessionClientTmuxSessionId,
    context.rcc_session_client_tmux_session_id
  ];
  for (const value of candidates) {
    const normalized = normalizeToken(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}
