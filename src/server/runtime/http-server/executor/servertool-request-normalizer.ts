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

function readNestedMetadata(baseContext: Record<string, unknown>): Record<string, unknown> | undefined {
  return asFlatRecord(baseContext.metadata);
}

function payloadContainsRccFence(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(payload).includes('<**rcc**>');
  } catch {
    return false;
  }
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

  const sessionId =
    readSessionLikeToken(baseContext.sessionId) ??
    readSessionLikeToken(baseContext.session_id) ??
    readSessionLikeToken(entryOrigin.sessionId) ??
    readSessionLikeToken(entryOrigin.session_id) ??
    readSessionLikeToken(requestMetadata?.sessionId) ??
    readSessionLikeToken(requestMetadata?.session_id);
  const conversationId =
    readSessionLikeToken(baseContext.conversationId) ??
    readSessionLikeToken(baseContext.conversation_id) ??
    readSessionLikeToken(entryOrigin.conversationId) ??
    readSessionLikeToken(entryOrigin.conversation_id) ??
    readSessionLikeToken(requestMetadata?.conversationId) ??
    readSessionLikeToken(requestMetadata?.conversation_id);

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
  const capturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  const capturedEntryRequest = asFlatRecord(baseContext.capturedEntryRequest);
  if (
    capturedEntryRequest
    && payloadContainsRccFence(capturedEntryRequest)
    && (!capturedChatRequest || !payloadContainsRccFence(capturedChatRequest))
  ) {
    baseContext.capturedChatRequest = capturedEntryRequest;
  }
  try {
    syncStoplessGoalStateFromRequest(baseContext);
  } catch (error) {
    onError?.(error);
  }
}
