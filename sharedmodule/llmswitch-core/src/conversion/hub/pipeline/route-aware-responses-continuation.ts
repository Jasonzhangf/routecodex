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


type ContinuationResolutionMode = 'none' | 'passthrough_remote_direct' | 'consult_scope_store';

function resolveContinuationResolutionMode(args: {
  request: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  normalizedMetadata?: Record<string, unknown>;
}): ContinuationResolutionMode {
  const requestRecord = isRecord(args.request) ? (args.request as Record<string, unknown>) : {};
  const rawRecord = isRecord(args.rawRequest) ? (args.rawRequest as Record<string, unknown>) : {};
  const metadata = isRecord(args.normalizedMetadata) ? args.normalizedMetadata : undefined;
  const runtime = isRecord(metadata?.__rt) ? (metadata?.__rt as Record<string, unknown>) : undefined;
  const entryEndpoint = typeof metadata?.entryEndpoint === 'string' ? metadata.entryEndpoint.trim() : '';

  if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
    return 'consult_scope_store';
  }
  if (
    isRecord(metadata?.responsesResume)
    && requestRecord.previous_response_id === undefined
    && rawRecord.previous_response_id === undefined
    && requestRecord.response_id === undefined
    && rawRecord.response_id === undefined
  ) {
    return 'consult_scope_store';
  }
  if (requestRecord.previous_response_id !== undefined || rawRecord.previous_response_id !== undefined) {
    return 'passthrough_remote_direct';
  }
  if (requestRecord.response_id !== undefined || rawRecord.response_id !== undefined) {
    return 'passthrough_remote_direct';
  }
  return 'none';
}


function readPinnedDirectProviderKey(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const responsesResume = isRecord(metadata.responsesResume) ? (metadata.responsesResume as Record<string, unknown>) : undefined;
  const continuation = isRecord(metadata.continuation) ? (metadata.continuation as Record<string, unknown>) : undefined;
  const responseSemantics = isRecord(metadata.responseSemantics) ? (metadata.responseSemantics as Record<string, unknown>) : undefined;
  const semanticsContinuation = isRecord(responseSemantics?.continuation) ? (responseSemantics?.continuation as Record<string, unknown>) : undefined;
  const candidates = [responsesResume, continuation, semanticsContinuation];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resumeFrom = isRecord(candidate.resumeFrom) ? (candidate.resumeFrom as Record<string, unknown>) : undefined;
    const direct = typeof resumeFrom?.providerKey === 'string' ? resumeFrom.providerKey.trim() : '';
    if (direct) return direct;
    const flat = typeof candidate.providerKey === 'string' ? candidate.providerKey.trim() : '';
    if (flat) return flat;
  }
  return undefined;
}

function assertDirectProviderOwnership(args: {
  normalizedMetadata?: Record<string, unknown>;
  outboundProviderKey?: string;
}): void {
  const pinnedProviderKey = readPinnedDirectProviderKey(args.normalizedMetadata);
  if (!pinnedProviderKey) {
    return;
  }
  const outboundProviderKey = typeof args.outboundProviderKey === 'string' ? args.outboundProviderKey.trim() : '';
  if (!outboundProviderKey) {
    return;
  }
  if (outboundProviderKey !== pinnedProviderKey) {
    throw new Error(`responses direct continuation provider mismatch: expected=${pinnedProviderKey} actual=${outboundProviderKey}`);
  }
}

function syncProviderKeyToRoutingPin(
  normalizedMetadata: Record<string, unknown> | undefined,
  meta: Record<string, unknown> | undefined
): void {
  if (!normalizedMetadata || !meta) {
    return;
  }
  const providerKey = readScopeToken(meta.providerKey);
  if (!providerKey) {
    return;
  }
  normalizedMetadata['__shadowCompareForcedProviderKey'] = providerKey;
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
  outboundProviderKey?: string;
}): StandardizedRequest | ProcessedRequest {
  if (args.entryProtocol !== 'openai-responses') {
    return args.request;
  }

  const scopeArgs = readScopeArgs(args);
  const continuationResolutionMode = resolveContinuationResolutionMode(args);

  if (continuationResolutionMode === 'none') {
    return args.request;
  }

  if (continuationResolutionMode === 'passthrough_remote_direct') {
    assertDirectProviderOwnership({
      normalizedMetadata: args.normalizedMetadata,
      outboundProviderKey: args.outboundProviderKey,
    });
    return args.request;
  }

  if (args.outboundProtocol === 'openai-responses') {
    const resumed = resumeLatestResponsesContinuationByScope(scopeArgs);
    if (!resumed || !isRecord(resumed.meta)) {
      return args.request;
    }
    syncProviderKeyToRoutingPin(args.normalizedMetadata, resumed.meta);
    return applyUnifiedResponsesResumeSemantics(args.request, resumed.meta, {
      deltaInput: Array.isArray((resumed.payload as Record<string, unknown>)?.input)
        ? cloneJson((resumed.payload as Record<string, unknown>).input)
        : [],
      restoredTools: Array.isArray((resumed.payload as Record<string, unknown>)?.tools)
        ? cloneJson((resumed.payload as Record<string, unknown>).tools)
        : undefined
    });
  }

  const materialized = materializeLatestResponsesContinuationByScope(scopeArgs);
  if (!materialized || !isRecord(materialized.payload) || !isRecord(materialized.meta)) {
    return args.request;
  }

  syncProviderKeyToRoutingPin(args.normalizedMetadata, materialized.meta);

  let next = cloneJson(args.request);
  if (Array.isArray(materialized.payload.input)) {
    next.messages = stripChatProcessHistoricalImages(
      convertInputToMessages(materialized.payload.input),
      '[Image omitted]'
    ).messages as any;
  }
  return applyUnifiedResponsesResumeSemantics(next, materialized.meta);
}
