import { resolveClockSessionScopeWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js';

export function buildClockSessionScopeFromDaemonId(_daemonId: string): string {
  return '';
}

export function extractClockDaemonIdFromSessionScope(_sessionScope: string): string | null {
  return null;
}

function readToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readTmuxSessionId(record: Record<string, unknown> | null | undefined): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  return (
    readToken(record.tmuxSessionId) ||
    readToken(record.tmux_session_id) ||
    readToken(record.clientTmuxSessionId) ||
    readToken(record.client_tmux_session_id)
  );
}

function readSessionId(record: Record<string, unknown> | null | undefined): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  return readToken(record.sessionId) || readToken(record.session_id) || readToken(record.conversationId) || readToken(record.conversation_id);
}

export function resolveClockSessionScope(
  primary?: Record<string, unknown> | null,
  fallback?: Record<string, unknown> | null
): string | null {
  const native = resolveClockSessionScopeWithNative(primary, fallback);
  if (native && native.trim()) {
    return native;
  }
  const tmuxSessionId = readTmuxSessionId(primary) || readTmuxSessionId(fallback);
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  const sessionId = readSessionId(primary) || readSessionId(fallback);
  return sessionId || null;
}
