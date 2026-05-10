import { convertBridgeInputToChatMessages } from '../../bridge-message-utils.js';
import { stripChatProcessHistoricalImages } from '../../../router/virtual-router/engine-selection/native-router-hotpath.js';
import { liftResponsesResumeIntoSemanticsWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js';
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

function applyUnifiedResponsesResumeSemantics(
  request: StandardizedRequest | ProcessedRequest,
  meta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): StandardizedRequest | ProcessedRequest {
  const next = cloneJson(request);
  const lifted = liftResponsesResumeIntoSemanticsWithNative(
    next as unknown as Record<string, unknown>,
    {
      payload: next as unknown as Record<string, unknown>,
      responsesResume: {
        ...cloneJson(meta),
        ...cloneJson(extra)
      }
    }
  );
  return lifted.request as unknown as StandardizedRequest | ProcessedRequest;
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
    return applyUnifiedResponsesResumeSemantics(args.request, resumed.meta, {
      deltaInput: Array.isArray((resumed.payload as Record<string, unknown>)?.input)
        ? cloneJson((resumed.payload as Record<string, unknown>).input)
        : []
    });
  }

  const materialized = materializeLatestResponsesContinuationByScope(scopeArgs);
  if (!materialized || !isRecord(materialized.payload) || !isRecord(materialized.meta)) {
    return args.request;
  }

  let next = cloneJson(args.request);
  if (Array.isArray(materialized.payload.input)) {
    next.messages = stripChatProcessHistoricalImages(
      convertInputToMessages(materialized.payload.input),
      '[Image omitted]'
    ).messages as any;
  }
  return applyUnifiedResponsesResumeSemantics(next, materialized.meta);
}
