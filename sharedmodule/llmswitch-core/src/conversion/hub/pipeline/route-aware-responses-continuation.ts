import { convertBridgeInputToChatMessages } from '../../bridge-message-utils.js';
import { stripChatProcessHistoricalImages } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import {
  materializeLatestResponsesContinuationByScope,
  resumeLatestResponsesContinuationByScope
} from '../../shared/responses-conversation-store.js';
import type { RestoreByScopeArgs } from '../../shared/responses-conversation-store-types.js';
import type { BridgeInputItem } from '../../types/bridge-message-types.js';
import type { JsonObject } from '../types/json.js';
import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readScopeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function ensureSemanticsNode(request: StandardizedRequest | ProcessedRequest): Record<string, unknown> {
  const root =
    request.semantics && typeof request.semantics === 'object' && !Array.isArray(request.semantics)
      ? ({ ...(request.semantics as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const responses =
    isRecord(root.responses)
      ? ({ ...(root.responses as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  root.responses = responses;
  request.semantics = root as any;
  return responses;
}

function attachResumeSemantics(
  request: StandardizedRequest | ProcessedRequest,
  meta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): void {
  const responses = ensureSemanticsNode(request);
  const existing =
    isRecord(responses.resume)
      ? ({ ...(responses.resume as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  responses.resume = {
    ...existing,
    ...cloneJson(meta),
    ...extra
  };
}

function readScopeArgs(args: {
  rawRequest: JsonObject;
  normalizedMetadata?: Record<string, unknown>;
  requestId: string;
}): RestoreByScopeArgs {
  return {
    payload: args.rawRequest as Record<string, unknown>,
    sessionId: readScopeToken(args.normalizedMetadata?.sessionId),
    conversationId: readScopeToken(args.normalizedMetadata?.conversationId),
    requestId: args.requestId
  };
}

function convertInputToMessages(input: unknown): Array<Record<string, unknown>> {
  return convertBridgeInputToChatMessages({
    input: Array.isArray(input) ? (cloneJson(input) as BridgeInputItem[]) : [],
    normalizeFunctionName: 'responses',
    toolResultFallbackText: '',
    allowDanglingToolCalls: true
  });
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

  const scopeArgs = readScopeArgs(args);

  if (args.outboundProtocol === 'openai-responses') {
    const resumed = resumeLatestResponsesContinuationByScope(scopeArgs);
    if (!resumed || !isRecord(resumed.meta)) {
      return args.request;
    }
    const next = cloneJson(args.request);
    attachResumeSemantics(next, resumed.meta, {
      deltaInput: Array.isArray((resumed.payload as Record<string, unknown>)?.input)
        ? cloneJson((resumed.payload as Record<string, unknown>).input)
        : []
    });
    return next;
  }

  const materialized = materializeLatestResponsesContinuationByScope(scopeArgs);
  if (!materialized || !isRecord(materialized.payload) || !isRecord(materialized.meta)) {
    return args.request;
  }

  const next = cloneJson(args.request);
  if (Array.isArray(materialized.payload.input)) {
    next.messages = stripChatProcessHistoricalImages(
      convertInputToMessages(materialized.payload.input),
      '[Image omitted]'
    ).messages as any;
  }
  attachResumeSemantics(next, materialized.meta);
  return next;
}
