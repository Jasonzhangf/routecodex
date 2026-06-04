import { syncStoplessGoalStateFromRequest } from '../../../../modules/llmswitch/bridge.js';

function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function backfillAdapterContextSessionIdentifiersFromEntryOriginRequest(
  baseContext: Record<string, unknown>,
  entryOriginRequest: unknown
): void {
  const entryOrigin = asFlatRecord(entryOriginRequest);
  if (!entryOrigin) {
    return;
  }
  const requestMetadata = asFlatRecord(entryOrigin.metadata);
  const capturedRequest = asFlatRecord(baseContext.capturedEntryRequest) ?? asFlatRecord(baseContext.capturedChatRequest);
  const capturedMetadata = asFlatRecord(capturedRequest?.metadata);

  const sessionId =
    readSessionLikeToken(baseContext.sessionId) ??
    readSessionLikeToken(entryOrigin.sessionId) ??
    readSessionLikeToken(entryOrigin.session_id) ??
    readSessionLikeToken(requestMetadata?.sessionId) ??
    readSessionLikeToken(requestMetadata?.session_id) ??
    readSessionLikeToken(capturedRequest?.sessionId) ??
    readSessionLikeToken(capturedRequest?.session_id) ??
    readSessionLikeToken(capturedMetadata?.sessionId) ??
    readSessionLikeToken(capturedMetadata?.session_id);
  const conversationId =
    readSessionLikeToken(baseContext.conversationId) ??
    readSessionLikeToken(entryOrigin.conversationId) ??
    readSessionLikeToken(entryOrigin.conversation_id) ??
    readSessionLikeToken(requestMetadata?.conversationId) ??
    readSessionLikeToken(requestMetadata?.conversation_id) ??
    readSessionLikeToken(capturedRequest?.conversationId) ??
    readSessionLikeToken(capturedRequest?.conversation_id) ??
    readSessionLikeToken(capturedMetadata?.conversationId) ??
    readSessionLikeToken(capturedMetadata?.conversation_id);

  if (sessionId && !readSessionLikeToken(baseContext.sessionId)) {
    baseContext.sessionId = sessionId;
  }
  if (conversationId && !readSessionLikeToken(baseContext.conversationId)) {
    baseContext.conversationId = conversationId;
  }
}

export function syncStoplessGoalStateFromCapturedRequest(
  baseContext: Record<string, unknown>,
  onError?: (error: unknown) => void
): void {
  try {
    syncStoplessGoalStateFromRequest(baseContext);
  } catch (error) {
    onError?.(error);
  }
}
