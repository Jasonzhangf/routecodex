import type {
  ProcessedRequest,
  StandardizedMessage,
  StandardizedRequest
} from '../types/standardized.js';
import type { JsonObject } from '../types/json.js';
import type { ChatSemantics } from '../types/chat-envelope.js';
import {
  materializeLatestResponsesContinuationByScope,
  resumeLatestResponsesContinuationByScope
} from '../../shared/responses-conversation-store.js';
import { extractSessionIdentifiersFromMetadata } from './session-identifiers.js';
import {
  buildChatRequestFromResponses,
  captureResponsesContext
} from '../../shared/responses-request-adapter.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasExplicitPreviousResponseId(rawRequest: JsonObject): boolean {
  return Boolean(readText((rawRequest as Record<string, unknown>).previous_response_id));
}

function cloneSemantics(
  request: StandardizedRequest | ProcessedRequest
): Record<string, unknown> {
  const semantics = (request as { semantics?: unknown }).semantics;
  return asRecord(semantics) ? { ...(semantics as Record<string, unknown>) } : {};
}

export function resolveRouteAwareResponsesContinuation(args: {
  request: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  normalizedMetadata?: Record<string, unknown>;
  requestId: string;
  entryProtocol: string;
  outboundProtocol: string;
}): StandardizedRequest | ProcessedRequest {
  if (args.entryProtocol !== 'openai-responses') {
    return args.request;
  }

  const rawRequestRecord = asRecord(args.rawRequest);
  if (!rawRequestRecord || hasExplicitPreviousResponseId(args.rawRequest)) {
    return args.request;
  }
  if (!Array.isArray(rawRequestRecord.input) || rawRequestRecord.input.length === 0) {
    return args.request;
  }

  const { sessionId, conversationId } = extractSessionIdentifiersFromMetadata(
    args.normalizedMetadata
  );
  if (!sessionId && !conversationId) {
    return args.request;
  }

  if (args.outboundProtocol !== 'openai-responses') {
    const materialized = materializeLatestResponsesContinuationByScope({
      payload: rawRequestRecord,
      sessionId,
      conversationId,
      requestId: args.requestId
    });
    const materializedPayload = asRecord(materialized?.payload);
    if (!materializedPayload) {
      return args.request;
    }
    const context = captureResponsesContext(materializedPayload, {
      route: { requestId: args.requestId }
    });
    const rebuilt = buildChatRequestFromResponses(materializedPayload, context).request;
    const rebuiltMessages = Array.isArray(rebuilt.messages)
      ? (rebuilt.messages as Array<Record<string, unknown>>)
      : undefined;
    if (!rebuiltMessages?.length) {
      return args.request;
    }
    const nextSemantics = cloneSemantics(args.request);
    const currentResponses = asRecord(nextSemantics.responses);
    const currentResume = asRecord(currentResponses?.resume);
    nextSemantics.responses = {
      ...(currentResponses ?? {}),
      resume: {
        ...(currentResume ?? {}),
        ...(asRecord(materialized?.meta) ?? {}),
        ...(sessionId ? { sessionId } : {}),
        ...(conversationId ? { conversationId } : {})
      }
    };
    return {
      ...args.request,
      model: typeof rebuilt.model === 'string' ? rebuilt.model : args.request.model,
      messages: rebuiltMessages as unknown as StandardizedMessage[],
      ...(Array.isArray(rebuilt.tools) ? { tools: rebuilt.tools as StandardizedRequest['tools'] } : {}),
      semantics: nextSemantics as ChatSemantics
    };
  }

  const restored = resumeLatestResponsesContinuationByScope({
    payload: rawRequestRecord,
    sessionId,
    conversationId,
    requestId: args.requestId
  });
  const restoredPayload = asRecord(restored?.payload);
  const restoredMeta = asRecord(restored?.meta);
  const restoredFromResponseId = readText(restoredMeta?.restoredFromResponseId)
    ?? readText(restoredPayload?.previous_response_id);
  const previousRequestId = readText(restoredMeta?.previousRequestId);
  const deltaInput = Array.isArray(restoredPayload?.input)
    ? (restoredPayload?.input as unknown[])
    : undefined;
  if (!restoredFromResponseId || !deltaInput) {
    return args.request;
  }

  const nextSemantics = cloneSemantics(args.request);
  const currentResponses = asRecord(nextSemantics.responses);
  const currentResume = asRecord(currentResponses?.resume);
  nextSemantics.responses = {
    ...(currentResponses ?? {}),
    resume: {
      ...(currentResume ?? {}),
      ...(restoredMeta ?? {}),
      deltaInput
    }
  };

  const currentContinuation = asRecord(nextSemantics.continuation);
  const currentResumeFrom = asRecord(currentContinuation?.resumeFrom);
  nextSemantics.continuation = {
    ...(currentContinuation ?? {}),
    ...(previousRequestId
      ? {
          chainId: readText(currentContinuation?.chainId) ?? previousRequestId,
          stickyScope: readText(currentContinuation?.stickyScope) ?? 'request_chain',
          stateOrigin: readText(currentContinuation?.stateOrigin) ?? 'openai-responses',
          restored: true
        }
      : {}),
    resumeFrom: {
      ...(currentResumeFrom ?? {}),
      protocol: readText(currentResumeFrom?.protocol) ?? 'openai-responses',
      ...(previousRequestId
        ? {
            requestId: readText(currentResumeFrom?.requestId) ?? previousRequestId
          }
        : {}),
      previousResponseId: restoredFromResponseId
    }
  };

  return {
    ...args.request,
    semantics: nextSemantics as ChatSemantics
  };
}
