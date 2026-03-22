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

function readConversationId(record: Record<string, unknown> | null | undefined): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  return readToken(record.conversationId) || readToken(record.conversation_id);
}

function readExplicitScope(record: Record<string, unknown> | null | undefined): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const explicit =
    readToken(record.stopMessageClientInjectSessionScope) ||
    readToken(record.stopMessageClientInjectScope) ||
    readToken(record.stop_message_client_inject_session_scope) ||
    readToken(record.stop_message_client_inject_scope);
  if (!explicit) {
    return null;
  }
  return /^(tmux|session|conversation):/i.test(explicit) ? explicit : null;
}

function pushUnique(scopes: string[], value: string | null | undefined): void {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || scopes.includes(normalized)) {
    return;
  }
  scopes.push(normalized);
}

export function resolveClockSessionScopeAliases(
  primary?: Record<string, unknown> | null,
  fallback?: Record<string, unknown> | null
): string[] {
  const scopes: string[] = [];
  pushUnique(scopes, readExplicitScope(primary));
  pushUnique(scopes, readExplicitScope(fallback));

  const native = resolveClockSessionScopeWithNative(primary, fallback);
  pushUnique(scopes, native && native.trim() ? native : null);

  const tmuxSessionId = readTmuxSessionId(primary) || readTmuxSessionId(fallback);
  if (tmuxSessionId) {
    pushUnique(scopes, `tmux:${tmuxSessionId}`);
  }

  const sessionId = readSessionId(primary) || readSessionId(fallback);
  if (sessionId) {
    pushUnique(scopes, sessionId);
    pushUnique(scopes, `session:${sessionId}`);
  }

  const conversationId = readConversationId(primary) || readConversationId(fallback);
  if (conversationId) {
    pushUnique(scopes, conversationId);
    pushUnique(scopes, `conversation:${conversationId}`);
  }

  return scopes;
}

export function resolveClockSessionScope(
  primary?: Record<string, unknown> | null,
  fallback?: Record<string, unknown> | null
): string | null {
  return resolveClockSessionScopeAliases(primary, fallback)[0] ?? null;
}
