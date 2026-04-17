import { syncReasoningStopModeFromRequest } from '../../../../modules/llmswitch/bridge.js';

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

export function backfillAdapterContextSessionIdentifiersFromOriginalRequest(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  const original = asFlatRecord(originalRequest);
  if (!original) {
    return;
  }
  const requestMetadata = asFlatRecord(original.metadata);
  const capturedRequest = asFlatRecord(baseContext.capturedChatRequest);
  const capturedMetadata = asFlatRecord(capturedRequest?.metadata);

  const sessionId =
    readSessionLikeToken(baseContext.sessionId) ??
    readSessionLikeToken(original.sessionId) ??
    readSessionLikeToken(original.session_id) ??
    readSessionLikeToken(requestMetadata?.sessionId) ??
    readSessionLikeToken(requestMetadata?.session_id) ??
    readSessionLikeToken(capturedRequest?.sessionId) ??
    readSessionLikeToken(capturedRequest?.session_id) ??
    readSessionLikeToken(capturedMetadata?.sessionId) ??
    readSessionLikeToken(capturedMetadata?.session_id);
  const conversationId =
    readSessionLikeToken(baseContext.conversationId) ??
    readSessionLikeToken(original.conversationId) ??
    readSessionLikeToken(original.conversation_id) ??
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

export function seedReasoningStopStateFromCapturedRequest(
  baseContext: Record<string, unknown>,
  onError?: (error: unknown) => void
): void {
  try {
    syncReasoningStopModeFromRequest(baseContext, 'on');
  } catch (error) {
    onError?.(error);
  }
}
