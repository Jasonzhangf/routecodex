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
  const candidates = [
    context.clientTmuxSessionId,
    context.client_tmux_session_id,
    context.tmuxSessionId,
    context.tmux_session_id,
    context.rccSessionClientTmuxSessionId,
    context.rcc_session_client_tmux_session_id,
    context.sessionId,
    context.session_id,
    context.conversationId,
    context.conversation_id,
    context.logSessionColorKey
  ];
  for (const candidate of candidates) {
    const normalized = normalizeToken(candidate);
    if (normalized) {
      return resolveNativeSessionLogColorKey({ logSessionColorKey: normalized });
    }
  }
  return undefined;
}
