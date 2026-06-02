import type { JsonObject } from '../types/json.js';
import {
  buildAnthropicResponseFromChatFullWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { buildChatResponseFromResponsesWithNative } from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { buildOpenAIChatResponseFromAnthropicMessageWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import {
  registerResponsesReasoning,
  consumeResponsesReasoning,
  registerResponsesOutputTextMeta,
  consumeResponsesOutputTextMeta,
  consumeResponsesPayloadSnapshotByAliases,
  registerResponsesPayloadSnapshot,
  consumeResponsesPassthroughByAliases,
  registerResponsesPassthrough
} from '../../shared/responses-reasoning-registry.js';
import {
  applyReasoningPayload,
  normalizeMessageReasoningPayload,
  type ToolAliasMap
} from './response-runtime-anthropic-helpers.js';

export interface AnthropicResponseOptions {
  aliasMap?: ToolAliasMap;
  includeToolCallIds?: boolean;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const structuredCloneImpl = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
    if (typeof structuredCloneImpl === 'function') {
      return structuredCloneImpl(value);
    }
  } catch {
    /* ignore structuredClone failures */
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function stripInternalContinuationRequestId(chat: Record<string, unknown>): void {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  const continuation =
    semantics?.continuation && typeof semantics.continuation === 'object' && !Array.isArray(semantics.continuation)
      ? (semantics.continuation as Record<string, unknown>)
      : undefined;
  const resumeFrom =
    continuation?.resumeFrom && typeof continuation.resumeFrom === 'object' && !Array.isArray(continuation.resumeFrom)
      ? (continuation.resumeFrom as Record<string, unknown>)
      : undefined;
  if (resumeFrom && typeof resumeFrom.requestId === 'string') {
    delete resumeFrom.requestId;
  }
}

function restoreResponsesSemanticsFromSnapshot(
  chatResponse: JsonObject,
  payloadSnapshot: Record<string, unknown> | undefined
): void {
  if (!payloadSnapshot || typeof payloadSnapshot !== 'object' || Array.isArray(payloadSnapshot)) {
    return;
  }
  const restored = buildChatResponseFromResponsesWithNative(payloadSnapshot);
  if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
    return;
  }
  stripInternalContinuationRequestId(restored);
  const semantics =
    restored.semantics && typeof restored.semantics === 'object' && !Array.isArray(restored.semantics)
      ? cloneJsonRecord(restored.semantics as Record<string, unknown>)
      : undefined;
  if (!semantics) {
    return;
  }
  (chatResponse as any).semantics = semantics;
}

function unwrapAnthropicMessagePayload(payload: JsonObject): JsonObject {
  const nested = payload?.data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as JsonObject;
    if (
      Array.isArray(record.content)
      || typeof record.stop_reason === 'string'
      || typeof record.role === 'string'
      || typeof record.model === 'string'
      || typeof record.id === 'string'
    ) {
      return record;
    }
  }
  return payload;
}

export function buildOpenAIChatFromAnthropicMessage(payload: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const messagePayload = unwrapAnthropicMessagePayload(payload);
  const requestId = typeof messagePayload.id === 'string' && messagePayload.id.trim().length
    ? messagePayload.id
    : 'unknown';
  const chatResponse = buildOpenAIChatResponseFromAnthropicMessageWithNative(
    messagePayload,
    requestId
  ) as JsonObject;

  const responseId = typeof chatResponse.id === 'string' && chatResponse.id.trim().length
    ? chatResponse.id
    : typeof messagePayload.id === 'string' && messagePayload.id.trim().length
      ? messagePayload.id
      : undefined;
  if (responseId) {
    const preserved = normalizeMessageReasoningPayload(consumeResponsesReasoning(responseId));
    if (preserved) {
      (chatResponse as any).__responses_reasoning = preserved;
      const message = (chatResponse as any).choices?.[0]?.message;
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        applyReasoningPayload(message as Record<string, unknown>, preserved);
      }
    }
    const preservedOutputMeta = consumeResponsesOutputTextMeta(responseId);
    if (preservedOutputMeta) {
      (chatResponse as any).__responses_output_text_meta = preservedOutputMeta;
    }
  }

  const retentionAliases = [
    responseId,
    typeof (messagePayload as any)?.request_id === 'string' ? (messagePayload as any).request_id : undefined,
    typeof (messagePayload as any)?.id === 'string' ? (messagePayload as any).id : undefined,
    typeof (payload as any)?.request_id === 'string' ? (payload as any).request_id : undefined,
    typeof (payload as any)?.id === 'string' ? (payload as any).id : undefined
  ];
  const payloadSnapshot = consumeResponsesPayloadSnapshotByAliases(retentionAliases);
  if (payloadSnapshot && responseId) {
    registerResponsesPayloadSnapshot(responseId, payloadSnapshot, { clone: false });
    (chatResponse as any).__responses_payload_snapshot = payloadSnapshot;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = responseId;
    }
    restoreResponsesSemanticsFromSnapshot(chatResponse, payloadSnapshot);
  }
  const passthroughPayload = consumeResponsesPassthroughByAliases(retentionAliases);
  if (passthroughPayload && responseId) {
    registerResponsesPassthrough(responseId, passthroughPayload, { clone: false });
    (chatResponse as any).__responses_passthrough = passthroughPayload;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = responseId;
    }
  }
  return chatResponse;
}

export function buildAnthropicResponseFromChat(chatResponse: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const aliasMap = options?.aliasMap;
  const input = {
    chat_response: JSON.stringify(chatResponse),
    alias_map: aliasMap ? JSON.stringify(aliasMap) : undefined,
    responses_reasoning: (chatResponse as any)?.__responses_reasoning
      ? JSON.stringify((chatResponse as any).__responses_reasoning)
      : undefined,
    responses_output_text_meta: (chatResponse as any)?.__responses_output_text_meta
      ? JSON.stringify((chatResponse as any).__responses_output_text_meta)
      : undefined,
    responses_payload_snapshot: (chatResponse as any)?.__responses_payload_snapshot
      ? JSON.stringify((chatResponse as any).__responses_payload_snapshot)
      : undefined,
    responses_passthrough: (chatResponse as any)?.__responses_passthrough
      ? JSON.stringify((chatResponse as any).__responses_passthrough)
      : undefined,
  };
  const output = buildAnthropicResponseFromChatFullWithNative(input);
  const parsed = JSON.parse(output);
  return JSON.parse(parsed.result);
}
