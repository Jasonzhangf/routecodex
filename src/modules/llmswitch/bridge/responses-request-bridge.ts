/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request/response conversation store writes on the handler side.
 */

// feature_id: server.responses_request_handler_bridge_surface
// canonical_builders: prepareResponsesHandlerEntryForHttp, captureResponsesRequestContextForHttp, recordResponsesResponseForHttp, seedResponsesToolCallResponseForHttp, clearResponsesConversationByRequestIdForHttp, readResponsesSessionIdFromHttp, readResponsesConversationIdFromHttp, shouldPersistResponsesConversationForHttp, readResponsesResponseIdFromHttp

import type { AnyRecord } from './module-loader.js';
import { applySystemPromptOverride } from '../../../utils/system-prompt-loader.js';
import {
  captureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest,
  resumeResponsesConversation,
} from './runtime-integrations.js';
import { planResponsesHandlerEntry } from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';

export type PrepareResponsesHandlerEntryForHttpArgs = {
  payload: AnyRecord;
  entryEndpoint: string;
  responseIdFromPath?: string;
  requestId: string;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export function readResponsesSessionIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = typeof metadata?.session_id === 'string'
    ? metadata.session_id
    : typeof metadata?.sessionId === 'string'
      ? metadata.sessionId
      : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

export function readResponsesConversationIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = typeof metadata?.conversation_id === 'string'
    ? metadata.conversation_id
    : typeof metadata?.conversationId === 'string'
      ? metadata.conversationId
      : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

export function shouldPersistResponsesConversationForHttp(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.store === true) {
    return true;
  }
  const previousResponseId =
    typeof record.previous_response_id === 'string' && record.previous_response_id.trim()
      ? record.previous_response_id.trim()
      : '';
  const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : [];
  return Boolean(previousResponseId && toolOutputs.length > 0);
}

export function readResponsesResponseIdFromHttp(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? (record.response as Record<string, unknown>)
    : undefined;
  for (const candidate of [record.id, record.response_id, nested?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export type PrepareResponsesHandlerEntryForHttpResult =
  | {
      kind: 'ok';
      payload: AnyRecord;
      pipelineEntryEndpoint: string;
      plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
      isSubmitToolOutputs: boolean;
      resumeMeta?: Record<string, unknown>;
    }
  | {
      kind: 'scope_continuation_expired';
    };

export function finalizeResponsesHandlerPayloadForHttp(args: {
  payload: AnyRecord;
  entryEndpoint: string;
  isSubmitToolOutputs: boolean;
  outboundStream: boolean;
}): AnyRecord {
  const payload = args.payload;
  if (!args.isSubmitToolOutputs && args.outboundStream && payload.stream !== true) {
    payload.stream = true;
  }
  if (!args.isSubmitToolOutputs && args.entryEndpoint === '/v1/responses') {
    applySystemPromptOverride(args.entryEndpoint, payload);
  }
  return payload;
}

export async function prepareResponsesHandlerEntryForHttp(
  args: PrepareResponsesHandlerEntryForHttpArgs
): Promise<PrepareResponsesHandlerEntryForHttpResult> {
  const plannedEntry = await planResponsesHandlerEntry(
    args.payload,
    args.entryEndpoint,
    args.responseIdFromPath
  );
  const payload = (plannedEntry.payload ?? {}) as AnyRecord;
  const isSubmitToolOutputs = plannedEntry.mode === 'submit_tool_outputs';
  let resumeMeta: Record<string, unknown> | undefined;
  let pipelineEntryEndpoint = args.entryEndpoint;

  if (args.responseIdFromPath && !payload.response_id) {
    payload.response_id = args.responseIdFromPath;
  }

  if (isSubmitToolOutputs) {
    const responseId = plannedEntry.responseId || args.responseIdFromPath;
    if (!responseId) {
      throw Object.assign(
        new Error('response_id is required for submit_tool_outputs'),
        {
          status: 400,
          code: 'bad_request',
          origin: 'client',
        }
      );
    }
    const resumeResult = await resumeResponsesConversation(responseId, payload, {
      requestId: args.requestId,
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    pipelineEntryEndpoint = args.entryEndpoint;
    return {
      kind: 'ok',
      payload: (resumeResult.payload ?? {}) as AnyRecord,
      pipelineEntryEndpoint,
      plannedEntryMode: plannedEntry.mode,
      isSubmitToolOutputs,
      resumeMeta: resumeResult.meta,
    };
  }

  if (plannedEntry.mode === 'scope_materialize') {
    const materialized = await materializeLatestResponsesContinuationByScope({
      payload,
      requestId: args.requestId,
      sessionId: args.sessionId,
      conversationId: args.conversationId,
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    if (!materialized) {
      return { kind: 'scope_continuation_expired' };
    }
    return {
      kind: 'ok',
      payload: (materialized.payload ?? {}) as AnyRecord,
      pipelineEntryEndpoint,
      plannedEntryMode: plannedEntry.mode,
      isSubmitToolOutputs,
      resumeMeta: materialized.meta,
    };
  }

  return {
    kind: 'ok',
    payload,
    pipelineEntryEndpoint,
    plannedEntryMode: plannedEntry.mode,
    isSubmitToolOutputs,
    resumeMeta,
  };
}

export async function captureResponsesRequestContextForHttp(args: {
  requestId: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<void> {
  await captureResponsesRequestContextForRequest(args);
}

export async function recordResponsesResponseForHttp(args: {
  requestId: string;
  response: AnyRecord;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
  sessionId?: string;
  conversationId?: string;
}): Promise<void> {
  await recordResponsesResponseForRequest(args);
}

export async function seedResponsesToolCallResponseForHttp(args: {
  body: unknown;
  requestContext?: {
    payload?: Record<string, unknown>;
    context?: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  providerKey?: string;
}): Promise<void> {
  const responseId = readResponsesResponseIdFromHttp(args.body);
  const finishReason = deriveFinishReason(args.body);
  if (!responseId || finishReason !== 'tool_calls') {
    return;
  }
  const requestContext = args.requestContext;
  if (!requestContext?.payload || !requestContext?.context) {
    return;
  }
  await captureResponsesRequestContextForHttp({
    requestId: responseId,
    payload: requestContext.payload,
    context: requestContext.context,
    sessionId: requestContext.sessionId,
    conversationId: requestContext.conversationId,
    matchedPort: requestContext.matchedPort,
    routingPolicyGroup: requestContext.routingPolicyGroup,
    providerKey: args.providerKey
  });
  if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) {
    await recordResponsesResponseForHttp({
      requestId: responseId,
      response: args.body as Record<string, unknown>,
      providerKey: args.providerKey,
      matchedPort: requestContext.matchedPort,
      routingPolicyGroup: requestContext.routingPolicyGroup,
      sessionId: requestContext.sessionId,
      conversationId: requestContext.conversationId
    });
  }
}

export async function clearResponsesConversationByRequestIdForHttp(
  requestId?: string
): Promise<void> {
  await clearResponsesConversationByRequestId(requestId);
}

export async function finalizeResponsesConversationRequestRetentionForHttp(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean }
): Promise<void> {
  await finalizeResponsesConversationRequestRetention(requestId, options);
}
