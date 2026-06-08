
/**
 * Phase Server-C: assertClientResponseHasNoInternalCarriers.
 * Client response body / SSE payload must NOT contain internal metadata,
 * Meta* carriers, Error* carriers, or Snapshot* carriers.
 * Violations must fail-fast, never silently delete.
 */
const CLIENT_RESPONSE_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'metaCarrier',
  'runtimeMetadata',
  'errorCarrier',
  'classifiedError',
  '__rt',
  '__internal',
  'snapshot',
  'snapshotId',
  '__raw_request_body',
  'internalDetails',
  'upstreamRequestId',
  'providerStack',
]);

const MAX_CARRIER_DEPTH = 20;

const INTERNAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  'routeHint',
  'routeName',
  'providerKey',
  'runtimeKey',
  'poolId',
  'serverToolFollowup',
  'serverToolFollowupMode',
  'stopMessageEnabled',
  'routecodexPortStopMessageEnabled',
  'clientAbortSignal',
  'clientConnectionState',
  '__routecodexDirectPassthrough',
]);

function isInternalMetadataCarrier(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith('__routecodex') || key.startsWith('__rt') || INTERNAL_METADATA_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

function findForbiddenFieldInResponsePayload(
  payload: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (seen.has(payload as object)) return undefined;
  seen.add(payload as object);
  if (depth >= MAX_CARRIER_DEPTH) return undefined;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findForbiddenFieldInResponsePayload(item, seen, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'metadata') {
      if (isInternalMetadataCarrier(value)) {
        return key;
      }
    }
    if (CLIENT_RESPONSE_FORBIDDEN_FIELDS.has(key)) {
      return key;
    }
    const found = findForbiddenFieldInResponsePayload(value, seen, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function assertClientResponseHasNoInternalCarriers(payload: unknown, requestId: string): void {
  const found = findForbiddenFieldInResponsePayload(payload);
  if (found) {
    throw new Error(
      `[server.response_projection] client response contains internal carrier field "${found}" (requestId=${requestId})`
    );
  }
}

import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import { formatRequestTimingSummary, logPipelineStage } from '../utils/stage-logger.js';
import { logUsageSummary } from '../runtime/http-server/executor/usage-logger.js';
import { extractUsageFromResult, normalizeUsage } from '../runtime/http-server/executor/usage-aggregator.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
import { isSnapshotsEnabled, writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../utils/finish-reason.js';
import { STREAM_CONTRACT_PROBE_BODY_KEY } from '../runtime/http-server/executor/servertool-response-normalizer.js';
import {
  colorizeRequestLog,
  formatHighlightedFinishReasonLabel,
  registerRequestLogContext
} from '../utils/request-log-color.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';
import { extractClientModelId } from '../runtime/http-server/executor/provider-response-utils.js';
import { buildResponsesTerminalSseFramesFromProbeNative, captureResponsesRequestContextForRequest, clearResponsesConversationByRequestId, createResponsesJsonToSseConverter, finalizeResponsesConversationRequestRetention, importCoreDist, isToolCallContinuationResponseNative, recordResponsesResponseForRequest, rebindResponsesConversationRequestId, requireCoreDist, updateResponsesContractProbeFromSseChunkNative } from '../../modules/llmswitch/bridge.js';

const BLOCKED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);

interface DispatchOptions {
  forceSSE?: boolean;
  entryEndpoint?: string;
  sseTotalTimeoutMs?: number;
  responsesRequestContext?: {
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
}

export interface SsePayloadShape {
  __sse_responses?: unknown;
}

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

type PipeCapable = { pipe?: unknown };
type WebReadable = { getReader?: () => unknown };
type AsyncIterableLike = { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

type SseFinishReasonTracker = {
  finishReason?: string;
  seenTerminalEvent: boolean;
};

type SseTerminalWatch = {
  sawTerminalChunk: boolean;
  sawResponsesCompletedChunk?: boolean;
  sawResponsesDoneEvent?: boolean;
  sawDoneChunk?: boolean;
  requiresResponsesTerminalEvent?: boolean;
  terminalSource?: string;
  pendingTerminalEvent?: 'response.completed' | 'response.done' | 'response.required_action' | 'response.error' | 'response.cancelled' | 'response.failed';
};


type StreamContractProbeEnvelope = {
  probe?: Record<string, unknown>;
  emitted?: boolean;
};

type ClientSseSnapshotRecorder = {
  record: (chunk: unknown) => void;
  flush: (error?: unknown) => void;
};

type ResponsesSseClientProjectionState = {
  pendingApplyPatchArgumentDeltas: Map<string, string>;
  applyPatchCallIds: Set<string>;
  emittedApplyPatchDoneCallIds: Set<string>;
};

function updateContractProbeFromSseChunk(
  chunk: unknown,
  contractProbe: StreamContractProbeEnvelope
): void {
  contractProbe.probe = updateResponsesContractProbeFromSseChunkNative(chunk, contractProbe.probe);
}

function buildResponsesTerminalSseFramesFromProbe(
  probe: Record<string, unknown> | undefined,
  requestLabel: string,
): string[] {
  return buildResponsesTerminalSseFramesFromProbeNative(probe, requestLabel);
}

type ChatUsageNormalizationResult = {
  payload: unknown;
  normalized: boolean;
  source?: 'body' | 'usage_log';
};


type ClientVisibleResponseRestoreContext = {
  model?: string;
  reasoningEffort?: string;
  requestId?: string;
};

const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';

function logResponseNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[handler-response] ${operation} failed (non-blocking): ${reason}`);
}

function resolveResponsesConversationRecordRequestIds(
  requestLabel: string,
  timingRequestIds: string[] | undefined,
  responseId?: unknown
): string[] {
  const responseIds: string[] = [];
  const requestIds: string[] = [];
  const add = (target: string[], value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || target.includes(trimmed)) return;
    target.push(trimmed);
  };
  add(responseIds, responseId);
  add(requestIds, requestLabel);
  if (Array.isArray(timingRequestIds)) {
    for (const id of timingRequestIds) add(requestIds, id);
  }
  if (responseIds.length > 0) {
    return responseIds;
  }
  return requestIds;
}

async function rebindResponsesConversationRequestIdsToResponseId(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: string;
}): Promise<void> {
  if (!args.responseId) {
    return;
  }
  const sourceIds: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === args.responseId || sourceIds.includes(trimmed)) return;
    sourceIds.push(trimmed);
  };
  add(args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  for (const requestId of sourceIds) {
    await rebindResponsesConversationRequestId(requestId, args.responseId).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-rebind:${requestId}->${args.responseId}`, error);
    });
  }
}

function deriveResponsesConversationProviderKey(usageLogInfo?: { providerKey?: string; timingRequestIds?: string[] }): string | undefined {
  const direct = typeof usageLogInfo?.providerKey === 'string' ? usageLogInfo.providerKey.trim() : '';
  if (direct) return direct;
  const ids = Array.isArray(usageLogInfo?.timingRequestIds) ? usageLogInfo.timingRequestIds : [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const match = id.match(/^openai-responses-(.+)-\d{8}T\d{9}-\d+-\d+$/);
    if (!match) continue;
    const normalized = match[1].replace(/-/g, '.');
    if (normalized) return normalized;
  }
  return undefined;
}

function readResponsesConversationResponseId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : undefined;
  for (const value of [record.id, record.response_id, nested?.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isToolCallContinuationResponse(body: unknown): boolean {
  return isToolCallContinuationResponseNative(body);
}

async function cleanupResponsesConversationSupersededRequestIds(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: string;
}): Promise<void> {
  if (!args.responseId) return;
  const supersededIds: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === args.responseId || supersededIds.includes(trimmed)) return;
    supersededIds.push(trimmed);
  };
  add(args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  for (const requestId of supersededIds) {
    await clearResponsesConversationByRequestId(requestId).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-clear-superseded:${requestId}`, error);
    });
  }
}

async function clearResponsesConversationRequestIds(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: string;
  reason: string;
}): Promise<void> {
  const ids: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || ids.includes(trimmed)) return;
    ids.push(trimmed);
  };
  add(args.requestLabel);
  add(args.responseId);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  for (const requestId of ids) {
    await clearResponsesConversationByRequestId(requestId).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-clear-${args.reason}:${requestId}`, error);
    });
  }
}

function shouldPersistResponsesToolCallContinuationRecord(
  entryEndpoint: string | undefined,
  requestContext?: DispatchOptions['responsesRequestContext']
): boolean {
  if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
    return true;
  }
  return entryEndpoint === '/v1/responses' && !!requestContext;
}

async function recordResponsesConversationToolCallResponse(args: {
  entryEndpoint?: string;
  requestLabel: string;
  timingRequestIds?: string[];
  providerKey?: string;
  sessionId?: unknown;
  conversationId?: unknown;
  requestContext?: DispatchOptions['responsesRequestContext'];
  body: unknown;
}): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return;
  }
  if (!shouldPersistResponsesToolCallContinuationRecord(args.entryEndpoint, args.requestContext)) {
    return;
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return;
  }
  if (!isToolCallContinuationResponse(args.body)) {
    return;
  }
  const recordBody = args.body as Record<string, unknown>;
  const responseId = readResponsesConversationResponseId(recordBody);
  await rebindResponsesConversationRequestIdsToResponseId({
    requestLabel: args.requestLabel,
    timingRequestIds: args.timingRequestIds,
    responseId,
  });
  const effectiveSessionId =
    typeof args.sessionId === 'string' && args.sessionId.trim()
      ? args.sessionId
      : args.requestContext?.sessionId;
  const effectiveConversationId =
    typeof args.conversationId === 'string' && args.conversationId.trim()
      ? args.conversationId
      : args.requestContext?.conversationId;
  const requestIds = resolveResponsesConversationRecordRequestIds(
    args.requestLabel,
    args.timingRequestIds,
    responseId
  );
  for (const recordRequestId of requestIds) {
    await recordResponsesResponseForRequest({
      requestId: recordRequestId,
      response: recordBody,
      sessionId: effectiveSessionId,
      conversationId: effectiveConversationId,
      providerKey: args.providerKey,
      matchedPort: args.requestContext?.matchedPort,
      routingPolicyGroup: args.requestContext?.routingPolicyGroup,
    }).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-record:${recordRequestId}`, error);
    });
  }
  await cleanupResponsesConversationSupersededRequestIds({
    requestLabel: args.requestLabel,
    timingRequestIds: args.timingRequestIds,
    responseId,
  });
  const retainRequestIds = resolveResponsesConversationRecordRequestIds(
    args.requestLabel,
    args.timingRequestIds,
    responseId
  );
  for (const retainRequestId of retainRequestIds) {
    await finalizeResponsesConversationRequestRetention(retainRequestId, {
      keepForSubmitToolOutputs: true,
    }).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-finalize:${retainRequestId}`, error);
    });
  }
}

async function finalizeResponsesConversationNonToolResponse(args: {
  entryEndpoint?: string;
  requestLabel: string;
  timingRequestIds?: string[];
  body: unknown;
}): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return;
  }
  const finishReason = deriveFinishReason(args.body);
  if (isToolCallContinuationResponse(args.body) || finishReason === 'tool_calls') {
    return;
  }
  const responseId = readResponsesConversationResponseId(args.body);
  const retainRequestIds = resolveResponsesConversationRecordRequestIds(
    args.requestLabel,
    args.timingRequestIds,
    responseId,
  );
  for (const retainRequestId of retainRequestIds) {
    await finalizeResponsesConversationRequestRetention(retainRequestId, {
      keepForSubmitToolOutputs: false,
    }).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-finalize:${retainRequestId}`, error);
    });
  }
}

async function captureResponsesConversationToolCallRequestContext(args: {
  entryEndpoint?: string;
  requestLabel: string;
  timingRequestIds?: string[];
  providerKey?: string;
  body: unknown;
  requestContext?: DispatchOptions['responsesRequestContext'];
}): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) return;
  if (!args.requestContext) return;
  if (!shouldPersistResponsesToolCallContinuationRecord(args.entryEndpoint, args.requestContext)) return;
  const requestPayload =
    args.requestContext.payload && typeof args.requestContext.payload === 'object' && !Array.isArray(args.requestContext.payload)
      ? (args.requestContext.payload as Record<string, unknown>)
      : undefined;
  if (!isToolCallContinuationResponse(args.body)) return;
  const body = args.body && typeof args.body === 'object' && !Array.isArray(args.body)
    ? args.body as Record<string, unknown>
    : undefined;
  const responseId = readResponsesConversationResponseId(body);
  const ids = resolveResponsesConversationRecordRequestIds(
    args.requestLabel,
    args.timingRequestIds,
    responseId
  );
  for (const requestId of ids) {
    await captureResponsesRequestContextForRequest({
      requestId,
      payload: args.requestContext.payload,
      context: args.requestContext.context,
      sessionId: args.requestContext.sessionId,
      conversationId: args.requestContext.conversationId,
      providerKey: args.providerKey,
      matchedPort: args.requestContext?.matchedPort,
      routingPolicyGroup: args.requestContext?.routingPolicyGroup,
    }).catch((error) => {
      logResponseNonBlockingError(`responses-conversation-capture:${requestId}`, error);
    });
  }
}

function logSseClientCloseDiagnosis(
  requestLabel: string,
  details: Record<string, unknown>
): void {
  try {
    console.warn(`[handler-response] response.sse.client_close request=${requestLabel} ${JSON.stringify(details)}`);
  } catch {
    console.warn(`[handler-response] response.sse.client_close request=${requestLabel}`);
  }
}

function cleanupAbandonedResponsesConversation(
  requestLabel: string,
  options: {
    entryEndpoint?: string;
    closeBeforeStreamEnd: boolean;
    timingRequestIds?: string[];
  }
): void {
  if (!options.closeBeforeStreamEnd || options.entryEndpoint !== '/v1/responses') {
    return;
  }
  void clearResponsesConversationRequestIds({
    requestLabel,
    timingRequestIds: options.timingRequestIds,
    reason: 'client-close',
  });
}

function formatTimestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function logStreamRequestComplete(
  endpoint: string | undefined,
  requestLabel: string,
  status: number,
  finishReason?: string,
  context?: { sessionId?: unknown; conversationId?: unknown }
): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  const targetEndpoint = endpoint && endpoint.trim() ? endpoint.trim() : '/unknown';
  const finishReasonLabel = formatHighlightedFinishReasonLabel(finishReason);
  const timingSuffix = formatRequestTimingSummary(requestLabel);
  const line = `✅ [${targetEndpoint}] ${formatTimestamp()} request ${requestLabel} completed (status=${status}${finishReasonLabel})${timingSuffix}`;
  console.warn(colorizeRequestLog(line, requestLabel, context));
}

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
}

function isChatCompletionsEndpoint(entryEndpoint?: string): boolean {
  return typeof entryEndpoint === 'string' && entryEndpoint.toLowerCase().includes('/v1/chat/completions');
}

function sanitizeNumericUsageField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function resolveNormalizedChatUsage(
  body: unknown,
  options: {
    entryEndpoint?: string;
    usageFallback?: Record<string, unknown>;
  }
): { usage?: Record<string, unknown>; source?: 'body' | 'usage_log' } {
  if (!isChatCompletionsEndpoint(options.entryEndpoint)) {
    return {};
  }
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const rawUsage = record?.usage;
  const normalizedFromBody = normalizeUsage(rawUsage);
  const normalizedFromFallback = normalizeUsage(options.usageFallback);
  const normalized = normalizedFromBody ?? normalizedFromFallback;
  if (!normalized) {
    return {};
  }
  const usageSource: 'body' | 'usage_log' = normalizedFromBody ? 'body' : 'usage_log';
  const usageRecord =
    rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
      ? ({ ...(rawUsage as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const promptTokens = sanitizeNumericUsageField(normalized.prompt_tokens);
  const completionTokens = sanitizeNumericUsageField(normalized.completion_tokens);
  let totalTokens = sanitizeNumericUsageField(normalized.total_tokens);
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
    totalTokens = promptTokens + completionTokens;
  }
  if (promptTokens !== undefined) {
    usageRecord.input_tokens = promptTokens;
    usageRecord.prompt_tokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    usageRecord.output_tokens = completionTokens;
    usageRecord.completion_tokens = completionTokens;
  }
  if (totalTokens !== undefined) {
    usageRecord.total_tokens = totalTokens;
  }
  return { usage: usageRecord, source: usageSource };
}

function normalizeChatUsagePayload(
  body: unknown,
  options: {
    entryEndpoint?: string;
    usageFallback?: Record<string, unknown>;
  }
): ChatUsageNormalizationResult {
  if (!isChatCompletionsEndpoint(options.entryEndpoint)) {
    return { payload: body, normalized: false };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { payload: body, normalized: false };
  }
  const record = body as Record<string, unknown>;
  if ('__sse_responses' in record) {
    return { payload: body, normalized: false };
  }
  const resolved = resolveNormalizedChatUsage(body, options);
  if (!resolved.usage) {
    return { payload: body, normalized: false };
  }
  return {
    payload: {
      ...record,
      usage: resolved.usage
    },
    normalized: true,
    source: resolved.source
  };
}

function resolveProviderProtocolHintFromSseFrame(frame: string): string | undefined {
  if (/\bevent:\s*response\./.test(frame) || /"type"\s*:\s*"response\./.test(frame)) {
    return 'openai-responses';
  }
  if (/\bevent:\s*message_/.test(frame) || /"type"\s*:\s*"message_/.test(frame)) {
    return 'anthropic';
  }
  return undefined;
}

function maybeUpdateUsageLogInfoFromSseFrame(
  result: PipelineExecutionResult,
  frame: string
): void {
  const usageLogInfo = result.usageLogInfo;
  if (!usageLogInfo || !frame || !/usage|usageMetadata|input_tokens|output_tokens|prompt_tokens|completion_tokens/.test(frame)) {
    return;
  }
  const usage = extractUsageFromResult({
    body: {
      bodyText: frame
    }
  }, {
    providerProtocol: resolveProviderProtocolHintFromSseFrame(frame)
  });
  if (!usage) {
    return;
  }
  const hasNonZeroUsage =
    (usage.prompt_tokens ?? 0) > 0
    || (usage.completion_tokens ?? 0) > 0
    || (usage.total_tokens ?? 0) > 0
    || (usage.cache_read_input_tokens ?? 0) > 0
    || (usage.cache_creation_input_tokens ?? 0) > 0;
  if (!hasNonZeroUsage) {
    return;
  }
  usageLogInfo.usage = usage as unknown as Record<string, unknown>;
}

export function normalizeResponsesJsonBody(
  body: unknown,
  entryEndpoint?: string,
  requestLabel?: string,
  resolveBridge: typeof requireCoreDist = requireCoreDist
): unknown {
  if (entryEndpoint !== '/v1/responses') {
    return body;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  if ((body as Record<string, unknown>).object !== 'chat.completion') {
    return body;
  }
  const mod = resolveBridge<{ buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown }>(
    'conversion/responses/responses-openai-bridge'
  );
  if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
    throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
  }
  return mod.buildResponsesPayloadFromChat(body, {
    requestId: requestLabel
  });
}


function readReasoningEffortCandidate(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const effort = (value as Record<string, unknown>).effort;
  return typeof effort === 'string' && effort.trim() ? effort.trim() : undefined;
}

function buildClientVisibleResponseRestoreContext(
  metadata: Record<string, unknown> | undefined
): ClientVisibleResponseRestoreContext | undefined {
  if (!metadata) {
    return undefined;
  }
  const clientModelId = extractClientModelId(metadata);
  const reasoningEffort =
    readReasoningEffortCandidate(metadata.reasoning)
    ?? (metadata.target && typeof metadata.target === 'object' && !Array.isArray(metadata.target)
      ? readReasoningEffortCandidate((metadata.target as Record<string, unknown>).reasoning)
      : undefined)
    ?? (metadata.originalRequest && typeof metadata.originalRequest === 'object' && !Array.isArray(metadata.originalRequest)
      ? readReasoningEffortCandidate((metadata.originalRequest as Record<string, unknown>).reasoning)
      : undefined)
  if (!clientModelId && !reasoningEffort) {
    return undefined;
  }
  return {
    ...(clientModelId ? { model: clientModelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function restoreClientVisibleResponsePayload(
  payload: unknown,
  restore: ClientVisibleResponseRestoreContext | undefined
): unknown {
  if (!restore || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const response =
    record.response && typeof record.response === 'object' && !Array.isArray(record.response)
      ? (record.response as Record<string, unknown>)
      : undefined;
  if (!response) {
    return payload;
  }
  const nextResponse: Record<string, unknown> = { ...response };
  let changed = false;
  if (restore.model && nextResponse.model !== restore.model) {
    nextResponse.model = restore.model;
    changed = true;
  }
  if (restore.reasoningEffort) {
    const currentReasoning =
      nextResponse.reasoning && typeof nextResponse.reasoning === 'object' && !Array.isArray(nextResponse.reasoning)
        ? (nextResponse.reasoning as Record<string, unknown>)
        : {};
    if (currentReasoning.effort !== restore.reasoningEffort) {
      nextResponse.reasoning = {
        ...currentReasoning,
        effort: restore.reasoningEffort
      };
      changed = true;
    }
  }
  return changed ? { ...record, response: nextResponse } : payload;
}

function createClientVisibleSseRestoreStream(
  stream: Readable,
  restore: ClientVisibleResponseRestoreContext | undefined
): Readable {
  let pending = '';
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending +=
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : chunk instanceof Uint8Array
                ? Buffer.from(chunk).toString('utf8')
                : String(chunk ?? '');
        const parts = pending.split(/\n\n/);
        pending = parts.pop() ?? '';
        for (const part of parts) {
          const frame = part + '\n\n';
          const normalized = frame.replace(/\n\n$/, '');
          const lines = normalized.split('\n');
          const dataLineIndex = lines.findIndex((line) => line.startsWith('data: '));
          if (dataLineIndex < 0) {
            this.push(frame);
            continue;
          }
          const dataText = lines[dataLineIndex].slice('data: '.length);
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataText);
          } catch {
            this.push(frame);
            continue;
          }
          assertClientResponseHasNoInternalCarriers(parsed, restore?.requestId ?? 'sse-frame');
          const restored = restoreClientVisibleResponsePayload(parsed, restore);
          if (restored === parsed) {
            this.push(frame);
            continue;
          }
          assertClientResponseHasNoInternalCarriers(restored, restore?.requestId ?? 'sse-frame');
          lines[dataLineIndex] = `data: ${JSON.stringify(restored)}`;
          this.push(`${lines.join('\n')}\n\n`);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (pending) {
          this.push(pending);
          pending = '';
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    }
  });
  return stream.pipe(transform);
}


function updateSseTerminalTrackerFromChunk(
  chunk: unknown,
  finishTracker: SseFinishReasonTracker,
  terminalWatch: SseTerminalWatch,
): void {
  const text =
    typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString('utf8')
          : '';
  if (!text) {
    return;
  }

  if (text.includes('data: [DONE]')) {
    terminalWatch.sawDoneChunk = true;
    if (!terminalWatch.requiresResponsesTerminalEvent) {
      finishTracker.seenTerminalEvent = true;
      terminalWatch.sawTerminalChunk = true;
      terminalWatch.terminalSource = terminalWatch.terminalSource ?? '[DONE]';
    }
  }

  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find(Boolean);
    if (
      eventName === 'response.completed'
      || eventName === 'response.done'
      || eventName === 'response.required_action'
      || eventName === 'response.failed'
      || eventName === 'response.error'
      || eventName === 'response.cancelled'
    ) {
      terminalWatch.pendingTerminalEvent = eventName;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(dataText) as unknown;
      const parsedType =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (typeof (parsed as Record<string, unknown>).type === 'string'
            ? ((parsed as Record<string, unknown>).type as string).trim()
            : '')
          : '';
      if (
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.required_action'
        || parsedType === 'response.failed'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
      ) {
        terminalWatch.pendingTerminalEvent = parsedType as SseTerminalWatch['pendingTerminalEvent'];
      }
      const derived = deriveFinishReason(parsed);
      if (!derived) {
        continue;
      }
      finishTracker.finishReason = derived;
      if (parsedType === 'response.completed') {
        terminalWatch.sawResponsesCompletedChunk = true;
      }
      if (parsedType === 'response.done') {
        terminalWatch.sawResponsesDoneEvent = true;
      }
      const trueTerminal = parsedType === 'response.completed' || parsedType === 'response.done' || parsedType === 'response.error' || parsedType === 'response.cancelled' || parsedType === 'response.failed';
      if (trueTerminal) {
        finishTracker.seenTerminalEvent = true;
        terminalWatch.sawTerminalChunk = true;
      }
      terminalWatch.terminalSource = terminalWatch.terminalSource ?? eventName ?? 'finish_reason';
    } catch {
      // ignore parse failure; handled by explicit response.* scanning below
    }
  }

  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find((name) => name === 'response.completed' || name === 'response.done' || name === 'response.required_action' || name === 'response.failed' || name === 'response.error' || name === 'response.cancelled');
    const effectiveTerminalEvent = (eventName ?? terminalWatch.pendingTerminalEvent ?? undefined) as string | undefined;
    if (!effectiveTerminalEvent) {
      continue;
    }
    if (!eventName) {
      terminalWatch.pendingTerminalEvent = undefined;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    let derived = finishTracker.finishReason;
    if (dataText && dataText !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataText) as unknown;
        derived = deriveFinishReason(parsed) ?? derived;
      } catch {
        // ignore parse failure; terminal event itself is enough to mark stream terminal
      }
    }
    if (effectiveTerminalEvent === 'response.completed') {
      terminalWatch.sawResponsesCompletedChunk = true;
    }
    if (effectiveTerminalEvent === 'response.done') {
      terminalWatch.sawResponsesDoneEvent = true;
    }
    const trueTerminal2 = effectiveTerminalEvent === 'response.completed' || effectiveTerminalEvent === 'response.done' || effectiveTerminalEvent === 'response.error' || effectiveTerminalEvent === 'response.cancelled' || effectiveTerminalEvent === 'response.failed';
    if (trueTerminal2) {
      finishTracker.seenTerminalEvent = true;
      terminalWatch.sawTerminalChunk = true;
    }
    finishTracker.finishReason = derived ?? finishTracker.finishReason;
    terminalWatch.terminalSource = effectiveTerminalEvent;
    terminalWatch.pendingTerminalEvent = undefined;
  }
}

function sendSseBridgeError(res: Response, requestLabel: string, status = 502): void {
  const payload = {
    type: 'error',
    status,
    error: {
      message: 'SSE stream missing from pipeline result',
      code: 'sse_bridge_error',
      request_id: requestLabel
    }
  };
  if (!res.headersSent) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
  }
  try {
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    logResponseNonBlockingError(`sendSseBridgeError:write:${requestLabel}`, error);
  }
  try {
    res.end();
  } catch (error) {
    logResponseNonBlockingError(`sendSseBridgeError:end:${requestLabel}`, error);
  }
}

function extractStructuredSseErrorPayload(body: unknown, requestLabel: string, status: number): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const error =
    record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  if (!error) {
    return null;
  }
  const payloadError: Record<string, unknown> = {
    ...error,
    request_id:
      typeof error.request_id === 'string' && error.request_id.trim()
        ? error.request_id
        : requestLabel
  };
  return {
    type: 'error',
    status,
    error: payloadError
  };
}

function sendStructuredSseError(res: Response, requestLabel: string, payload: Record<string, unknown>): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  try {
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    logResponseNonBlockingError(`sendStructuredSseError:write:${requestLabel}`, error);
  }
  try {
    res.end();
  } catch (error) {
    logResponseNonBlockingError(`sendStructuredSseError:end:${requestLabel}`, error);
  }
}


function readResponsesClientToolsRaw(requestContext?: DispatchOptions['responsesRequestContext']): unknown[] {
  const payloadTools = Array.isArray(requestContext?.payload?.tools) ? requestContext.payload.tools : undefined;
  if (payloadTools?.length) {
    return payloadTools;
  }
  const contextTools = Array.isArray(requestContext?.context?.toolsRaw) ? requestContext.context.toolsRaw : undefined;
  if (contextTools?.length) {
    return contextTools;
  }
  const contextClientTools = Array.isArray(requestContext?.context?.clientToolsRaw)
    ? requestContext.context.clientToolsRaw
    : undefined;
  return contextClientTools?.length ? contextClientTools : [];
}

async function normalizeResponsesToolCallsForClientBody(
  body: unknown,
  entryEndpoint?: string,
  requestContext?: DispatchOptions['responsesRequestContext']
): Promise<unknown> {
  if (
    entryEndpoint !== '/v1/responses'
    && entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return body;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || hasSsePayload(body)) {
    return body;
  }
  try {
    const mod = await importCoreDist<{ normalizeResponsesToolCallArgumentsForClientWithNative?: (payload: unknown, toolsRaw: unknown[]) => Record<string, unknown> }>(
      'native/router-hotpath/native-hub-pipeline-resp-semantics'
    );
    if (typeof mod.normalizeResponsesToolCallArgumentsForClientWithNative !== 'function') {
      throw new Error('[handler-response] normalizeResponsesToolCallArgumentsForClientWithNative not available');
    }
    const normalized = mod.normalizeResponsesToolCallArgumentsForClientWithNative(body, readResponsesClientToolsRaw(requestContext));
    return isResponsesApplyPatchFreeformTool(requestContext)
      ? convertApplyPatchFunctionCallsToCustomToolCalls(normalized)
      : normalized;
  } catch (error) {
    logResponseNonBlockingError('normalizeResponsesToolCallsForClientBody', error);
    return body;
  }
}

function isResponsesApplyPatchFreeformTool(requestContext?: DispatchOptions['responsesRequestContext']): boolean {
  return readResponsesClientToolsRaw(requestContext).some((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
    const record = tool as Record<string, unknown>;
    return record.type === 'custom'
      && record.name === 'apply_patch'
      && (!record.format || typeof record.format === 'object');
  });
}

function convertApplyPatchFunctionCallsToCustomToolCalls(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = convertApplyPatchFunctionCallsToCustomToolCalls(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'function_call' && record.name === 'apply_patch') {
    const input = typeof record.arguments === 'string'
      ? normalizeApplyPatchFreeformInputForClient(record.arguments)
      : '';
    const callId = typeof record.call_id === 'string'
      ? record.call_id
      : typeof record.id === 'string'
        ? record.id
        : 'call_apply_patch';
    return {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: callId,
      input,
    };
  }
  if (record.type === 'custom_tool_call' && record.name === 'apply_patch' && typeof record.input === 'string') {
    const input = normalizeApplyPatchFreeformInputForClient(record.input);
    if (input !== record.input) {
      return { ...record, input };
    }
  }
  let changed = false;
  const out: Record<string, unknown> = { ...record };
  for (const [key, child] of Object.entries(record)) {
    const next = convertApplyPatchFunctionCallsToCustomToolCalls(child);
    if (next !== child) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? out : value;
}

function normalizeApplyPatchFreeformInputForClient(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.patch === 'string') return record.patch;
      if (typeof record.input === 'string') return record.input;
    }
  } catch {
    return argumentsText;
  }
  return argumentsText;
}

async function normalizeResponsesToolCallsForClientPayloadDeep(
  value: unknown,
  entryEndpoint?: string,
  requestContext?: DispatchOptions['responsesRequestContext'],
  seen: WeakSet<object> = new WeakSet()
): Promise<unknown> {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    let changed = false;
    const items: unknown[] = [];
    for (const item of value) {
      const normalized = await normalizeResponsesToolCallsForClientPayloadDeep(item, entryEndpoint, requestContext, seen);
      items.push(normalized);
      if (normalized !== item) changed = true;
    }
    return changed ? items : value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...record };
  for (const [key, child] of Object.entries(record)) {
    const normalizedChild = await normalizeResponsesToolCallsForClientPayloadDeep(child, entryEndpoint, requestContext, seen);
    if (normalizedChild !== child) {
      out[key] = normalizedChild;
      changed = true;
    }
  }
  const normalizedSelf = await normalizeResponsesToolCallsForClientBody(
    changed ? out : record,
    entryEndpoint,
    requestContext
  );
  return normalizedSelf;
}

async function normalizeResponsesSseFrameForClient(
  frame: string,
  entryEndpoint?: string,
  requestContext?: DispatchOptions['responsesRequestContext'],
  projectionState?: ResponsesSseClientProjectionState
): Promise<string> {
  if (
    entryEndpoint !== '/v1/responses'
    && entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return frame;
  }
  const lines = frame.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (dataIndex < 0 || !eventLine) {
    return frame;
  }
  const eventName = eventLine.slice('event:'.length).trim();
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return frame;
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return frame;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return frame;
  }
  const item = data.item && typeof data.item === 'object' && !Array.isArray(data.item)
    ? data.item as Record<string, unknown>
    : undefined;
  if (
    item
    && item.type === 'function_call'
    && item.name === 'apply_patch'
    && typeof item.call_id === 'string'
    && projectionState
  ) {
    projectionState.applyPatchCallIds.add(item.call_id);
  }
  if (eventName === 'response.function_call_arguments.delta') {
    const callName = typeof data.name === 'string' ? data.name : undefined;
    const callId = typeof data.call_id === 'string' ? data.call_id : 'call_apply_patch';
    const delta = typeof data.delta === 'string' ? data.delta : undefined;
    if (
      delta
      && projectionState
      && (callName === 'apply_patch' || projectionState.applyPatchCallIds.has(callId))
    ) {
      projectionState.pendingApplyPatchArgumentDeltas.set(
        callId,
        `${projectionState.pendingApplyPatchArgumentDeltas.get(callId) ?? ''}${delta}`
      );
      return '';
    }
    return frame;
  }
  const callName =
    typeof data.name === 'string'
      ? data.name
      : data.item && typeof data.item === 'object' && !Array.isArray(data.item)
        ? typeof (data.item as Record<string, unknown>).name === 'string'
          ? (data.item as Record<string, unknown>).name as string
          : undefined
        : undefined;
  const callArguments =
    typeof data.arguments === 'string'
      ? data.arguments
      : data.item && typeof data.item === 'object' && !Array.isArray(data.item)
        ? typeof (data.item as Record<string, unknown>).arguments === 'string'
          ? (data.item as Record<string, unknown>).arguments as string
          : undefined
        : undefined;
  if (callName === 'apply_patch' && callArguments) {
    const normalized = await normalizeResponsesToolCallsForClientBody(
      {
        output: [{
          type: 'function_call',
          name: callName,
          call_id: typeof data.call_id === 'string' ? data.call_id : 'call_apply_patch',
          arguments: callArguments,
        }],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{
              id: typeof data.call_id === 'string' ? data.call_id : 'call_apply_patch',
              type: 'function',
              name: callName,
              arguments: callArguments,
              function: {
                name: callName,
                arguments: callArguments,
              },
            }],
          },
        },
      },
      entryEndpoint,
      requestContext
    ) as Record<string, unknown>;
    const normalizedArguments = normalizeApplyPatchFreeformInputForClient(callArguments);
    if (typeof data.arguments === 'string') {
      data.arguments = normalizedArguments;
    }
    if (data.item && typeof data.item === 'object' && !Array.isArray(data.item)) {
      (data.item as Record<string, unknown>).arguments = normalizedArguments;
    }
    const clientData = isResponsesApplyPatchFreeformTool(requestContext)
      ? convertApplyPatchFunctionCallsToCustomToolCalls(data)
      : data;
    const normalizedFrame = `${lines.map((line, index) => {
      if (index === dataIndex) return `data: ${JSON.stringify(clientData)}`;
      if (index > dataIndex && line.startsWith('data:')) return '';
      return line;
    }).filter((line) => line !== '').join('\n')}\n\n`;
    if (
      eventName === 'response.function_call_arguments.done'
      && projectionState
      && typeof data.call_id === 'string'
    ) {
      projectionState.pendingApplyPatchArgumentDeltas.delete(data.call_id);
      projectionState.applyPatchCallIds.delete(data.call_id);
      if (projectionState.emittedApplyPatchDoneCallIds.has(data.call_id)) {
        return '';
      }
      projectionState.emittedApplyPatchDoneCallIds.add(data.call_id);
      const customToolDoneData = {
        type: 'response.output_item.done',
        item: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: data.call_id,
          input: normalizedArguments,
        },
      };
      return `event: response.output_item.done\ndata: ${JSON.stringify(customToolDoneData)}\n\n`;
    }
    if (
      eventName === 'response.output_item.done'
      && projectionState
      && typeof data.item === 'object'
      && data.item !== null
      && !Array.isArray(data.item)
    ) {
      const callId = typeof (data.item as Record<string, unknown>).call_id === 'string'
        ? (data.item as Record<string, unknown>).call_id as string
        : undefined;
      if (callId) {
        if (projectionState.emittedApplyPatchDoneCallIds.has(callId)) {
          return '';
        }
        projectionState.emittedApplyPatchDoneCallIds.add(callId);
      }
    }
    return normalizedFrame;
  }
  const normalized = await normalizeResponsesToolCallsForClientPayloadDeep(data, entryEndpoint, requestContext);
  if (normalized === data) {
    return frame;
  }
  return `${lines.map((line, index) => {
    if (index === dataIndex) return `data: ${JSON.stringify(normalized)}`;
    if (index > dataIndex && line.startsWith('data:')) return '';
    return line;
  }).filter((line) => line !== '').join('\n')}\n\n`;
}

function isResponsesJsonBody(body: unknown, entryEndpoint?: string): body is Record<string, unknown> {
  if (
    entryEndpoint !== '/v1/responses'
    && entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return false;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || hasSsePayload(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return record.object === 'response' || typeof record.output === 'object' || typeof record.status === 'string';
}

function isChatCompletionJsonBody(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || hasSsePayload(body)) {
    return false;
  }
  return (body as Record<string, unknown>).object === 'chat.completion';
}

function streamResponsesJsonAsSse(args: {
  res: Response;
  requestLabel: string;
  result: PipelineExecutionResult;
  status: number;
  entryEndpoint?: string;
  responsesRequestContext?: DispatchOptions['responsesRequestContext'];
  logResponseCompleted: (details?: Record<string, unknown>) => void;
}): boolean {
  if (!isResponsesJsonBody(args.result.body, args.entryEndpoint)) {
    if (!isChatCompletionJsonBody(args.result.body) || args.entryEndpoint !== '/v1/responses') {
      return false;
    }
  }
  const flushable = args.res as FlushableResponse;
  args.res.status(args.status);
  args.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  args.res.setHeader('Cache-Control', 'no-cache, no-transform');
  args.res.setHeader('Connection', 'keep-alive');
  if (typeof flushable.flushHeaders === 'function') {
    flushable.flushHeaders();
  } else if (typeof flushable.flush === 'function') {
    flushable.flush();
  }
  void (async () => {
    try {
      const converter = await createResponsesJsonToSseConverter();
      const responsesPayload = isResponsesJsonBody(args.result.body, args.entryEndpoint)
        ? args.result.body
        : await (async () => {
          const mod = await importCoreDist<{ buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown }>(
            'conversion/responses/responses-openai-bridge'
          );
          if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
            throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
          }
          return mod.buildResponsesPayloadFromChat(args.result.body, {
            requestId: args.requestLabel
          }) as Record<string, unknown>;
        })();
      const normalizedResponsesPayload = await normalizeResponsesToolCallsForClientBody(
        responsesPayload,
        args.entryEndpoint,
        args.result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined
          ?? args.responsesRequestContext
      ) as Record<string, unknown>;
      const sanitizedResponsesPayload = stripInternalKeysDeep(normalizedResponsesPayload);
      const conversationProviderKey = deriveResponsesConversationProviderKey(args.result.usageLogInfo);
      await captureResponsesConversationToolCallRequestContext({
        entryEndpoint: args.entryEndpoint,
        requestLabel: args.requestLabel,
        timingRequestIds: args.result.usageLogInfo?.timingRequestIds,
        providerKey: conversationProviderKey,
        body: sanitizedResponsesPayload,
        requestContext:
          (args.result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined)
          ?? args.responsesRequestContext,
      });
      await recordResponsesConversationToolCallResponse({
        entryEndpoint: args.entryEndpoint,
        requestLabel: args.requestLabel,
        timingRequestIds: args.result.usageLogInfo?.timingRequestIds,
        providerKey: conversationProviderKey,
        sessionId: args.result.usageLogInfo?.sessionId,
        conversationId: args.result.usageLogInfo?.conversationId,
        requestContext:
          (args.result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined)
          ?? args.responsesRequestContext,
        body: sanitizedResponsesPayload
      });
      const sse = await converter.convertResponseToJsonToSse(normalizedResponsesPayload, {
        requestId: args.requestLabel
      });
      const stream = toNodeReadable(sse);
      if (!stream) {
        sendSseBridgeError(args.res, args.requestLabel, 502);
        return;
      }
      stream.on('end', () => {
        if (!args.res.writableEnded && !args.res.destroyed) {
          args.res.end();
        }
        args.logResponseCompleted({
          status: args.status,
          mode: 'sse',
          finishReason: deriveFinishReason(args.result.body)
        });
      });
      stream.on('error', (error: Error) => {
        logResponseNonBlockingError(`response.sse.json_bridge.stream:${args.requestLabel}`, error);
        if (!args.res.writableEnded && !args.res.destroyed) {
          sendSseBridgeError(args.res, args.requestLabel, 502);
        }
      });
      stream.pipe(args.res, { end: false });
    } catch (error) {
      logResponseNonBlockingError(`response.sse.json_bridge:${args.requestLabel}`, error);
      if (!args.res.writableEnded && !args.res.destroyed) {
        sendSseBridgeError(args.res, args.requestLabel, 502);
      }
    }
  })();
  return true;
}

export function hasSsePayload(body: unknown): body is SsePayloadShape {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

function shouldDispatchSseToClient(
  body: unknown,
  result: PipelineExecutionResult,
  forceSSE: boolean
): boolean {
  if (!hasSsePayload(body)) {
    return false;
  }
  if (forceSSE) {
    return true;
  }
  const metadata =
    result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
      ? (result.metadata as Record<string, unknown>)
      : undefined;
  return metadata?.outboundStream === true || metadata?.stream === true;
}

export function isAnalysisModeEnabled(): boolean {
  const mode = String(process.env.ROUTECODEX_MODE || process.env.RCC_MODE || '').trim().toLowerCase();
  if (mode === 'analysis') {
    return true;
  }
  const flag = String(process.env.ROUTECODEX_ANALYSIS || process.env.RCC_ANALYSIS || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') {
    return true;
  }
  return false;
}

export async function sendPipelineResponse(
  res: Response,
  result: PipelineExecutionResult,
  requestId?: string,
  options?: DispatchOptions
): Promise<void> {
  const status = typeof result.status === 'number' ? result.status : 200;
  const body = result.body;
  const requestLabel = formatRequestId(requestId);
  const forceSSE = options?.forceSSE === true;
  const expectsStream = shouldDispatchSseToClient(body, result, forceSSE);
  const entryEndpoint = typeof options?.entryEndpoint === 'string' && options.entryEndpoint.trim()
    ? options.entryEndpoint.trim()
    : undefined;
  const requestLogContext = {
    sessionId: result.usageLogInfo?.sessionId,
    conversationId: result.usageLogInfo?.conversationId
  };
  registerRequestLogContext(requestLabel, requestLogContext);
  const captureClientResponse = shouldCaptureClientResponseSnapshotStage('client-response');
  const responseStartedAtMs = Date.now();
  let responseCompletedLogged = false;

  const logResponseCompleted = (details?: Record<string, unknown>) => {
    if (responseCompletedLogged) {
      return;
    }
    responseCompletedLogged = true;
    const elapsedMs = Date.now() - responseStartedAtMs;
    logPipelineStage('response.completed', requestLabel, {
      elapsedMs,
      ...(details ?? {})
    });
    const usageLogInfo = result.usageLogInfo;
    if (usageLogInfo) {
      const finishReasonFromDetails =
        typeof details?.finishReason === 'string' && details.finishReason.trim()
          ? details.finishReason.trim()
          : undefined;
      const resolvedFinishReason = finishReasonFromDetails || usageLogInfo.finishReason;
      logPipelineStage('request.usage_log.start', requestLabel, {
        providerKey: usageLogInfo.providerKey
      });
      logUsageSummary(requestLabel, {
        providerKey: usageLogInfo.providerKey,
        model: usageLogInfo.model,
        routeName: usageLogInfo.routeName,
        poolId: usageLogInfo.poolId,
        finishReason: resolvedFinishReason,
        usage: usageLogInfo.usage as any,
        externalLatencyMs: usageLogInfo.externalLatencyMs,
        trafficWaitMs: usageLogInfo.trafficWaitMs,
        clientInjectWaitMs: usageLogInfo.clientInjectWaitMs,
        sseDecodeMs: usageLogInfo.sseDecodeMs,
        codecDecodeMs: usageLogInfo.codecDecodeMs,
        providerDecodeTag: usageLogInfo.providerDecodeTag,
        providerAttemptCount: usageLogInfo.providerAttemptCount,
        retryCount: usageLogInfo.retryCount,
        hubStageTop: usageLogInfo.hubStageTop as any,
        latencyMs: Date.now() - usageLogInfo.requestStartedAtMs,
        timingRequestIds: usageLogInfo.timingRequestIds,
        sessionId: usageLogInfo.sessionId,
        conversationId: usageLogInfo.conversationId,
        projectPath: usageLogInfo.projectPath,
        firstContentAtMs: usageLogInfo.firstContentAtMs,
        lastContentAtMs: usageLogInfo.lastContentAtMs,
        requestStartedAtMs: usageLogInfo.requestStartedAtMs,
        providerRequestId: usageLogInfo.providerRequestId,
        inputRequestId: usageLogInfo.inputRequestId
      });
      logPipelineStage('request.usage_log.completed', requestLabel, {
        providerKey: usageLogInfo.providerKey
      });
      formatRequestTimingSummary(requestLabel, { terminal: true });
      return;
    }
    formatRequestTimingSummary(requestLabel, { terminal: true });
  };

  if (forceSSE && !expectsStream) {
    if (streamResponsesJsonAsSse({
      res,
      requestLabel,
      result,
      status,
      entryEndpoint,
      responsesRequestContext: options?.responsesRequestContext,
      logResponseCompleted
    })) {
      return;
    }
    logPipelineStage('response.sse.missing', requestLabel, { status });
    const structuredErrorPayload = extractStructuredSseErrorPayload(body, requestLabel, status);
    logResponseCompleted({
      status: 200,
      mode: 'sse',
      reason: structuredErrorPayload ? 'structured_error_passthrough' : 'missing_stream',
      bridgeStatus: structuredErrorPayload ? status : 502
    });
    if (shouldCaptureClientResponseSnapshotStage('client-response.error')) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: requestLabel,
        entryEndpoint,
        data: {
          mode: 'sse',
          status: 200,
          payload: structuredErrorPayload ?? {
            type: 'error',
            status: 502,
            error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' }
          }
        }
      }).catch((error) => {
        logResponseNonBlockingError(`writeServerSnapshot:sse_missing:${requestLabel}`, error);
      });
    }
    if (structuredErrorPayload) {
      sendStructuredSseError(res, requestLabel, structuredErrorPayload);
      return;
    }
    sendSseBridgeError(res, requestLabel, 502);
    return Promise.resolve();
  }

  logPipelineStage('response.dispatch.start', requestLabel, { status, stream: expectsStream, forced: forceSSE });

  if (expectsStream) {
    const sseBody = body as SsePayloadShape & Record<string, unknown>;
    const streamSource = sseBody.__sse_responses;
    const stream = toNodeReadable(streamSource);
    const restoreContext = buildClientVisibleResponseRestoreContext({ ...result.metadata, requestId: requestLabel })
      ?? { requestId: requestLabel };
    if (!stream) {
      logPipelineStage('response.sse.missing', requestLabel, {});
      logResponseCompleted({ status: 200, mode: 'sse', reason: 'missing_stream', bridgeStatus: 502 });
      if (shouldCaptureClientResponseSnapshotStage('client-response.error')) {
        void writeServerSnapshot({
          phase: 'client-response.error',
          requestId: requestLabel,
          entryEndpoint,
          data: {
            mode: 'sse',
            status: 200,
            payload: {
              type: 'error',
              status: 502,
              error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' }
            }
          }
        }).catch((error) => {
          logResponseNonBlockingError(`writeServerSnapshot:sse_missing_stream:${requestLabel}`, error);
        });
      }
      sendSseBridgeError(res, requestLabel, 502);
      return;
    }
    const restoredStream = createClientVisibleSseRestoreStream(stream, restoreContext);
    const clientSseSnapshotRecorder = captureClientResponse
      ? createClientSseSnapshotRecorder(restoredStream, res, {
        requestId: requestLabel,
        entryEndpoint,
        status,
        headers: result.headers
      })
      : undefined;
    const outboundStream = captureClientResponse
      ? maybeAttachClientSseSnapshotStream(restoredStream, clientSseSnapshotRecorder)
      : restoredStream;
    applyHeaders(res, result.headers, true);
    const streamUsage = resolveNormalizedChatUsage(body, {
      entryEndpoint,
      usageFallback: result.usageLogInfo?.usage
    });
    void streamUsage;
    res.status(status);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    const flushable = res as FlushableResponse;
    if (typeof flushable.flushHeaders === 'function') {
      flushable.flushHeaders();
    } else if (typeof flushable.flush === 'function') {
      flushable.flush();
    }
    logPipelineStage('response.sse.stream.start', requestLabel, { status });
    getSessionExecutionStateTracker().recordSseStreamStart(requestLabel);

    const writeClientSseFrame = (
      frame: string,
      errorLabel: string,
      options?: { recordSnapshot?: boolean }
    ) => {
      if (options?.recordSnapshot !== false) {
        clientSseSnapshotRecorder?.record(frame);
      }
      try {
        res.write(frame);
      } catch (error) {
        logResponseNonBlockingError(`${errorLabel}:${requestLabel}`, error);
      }
    };

    let ended = false;
    let completedLogged = false;
    let cleanupLogged = false;
    let streamEnded = false;
    let preservedConversationOnClientClose = false;
    const finishTracker: SseFinishReasonTracker = {
      finishReason:
        typeof sseBody[STREAM_LOG_FINISH_REASON_KEY] === 'string'
          ? String(sseBody[STREAM_LOG_FINISH_REASON_KEY])
          : undefined,
      seenTerminalEvent: false,
    };
    let totalTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let terminalFlushTimer: NodeJS.Timeout | null = null;
    let terminalAutoCloseTimer: NodeJS.Timeout | null = null;
    const terminalWatch: SseTerminalWatch = {
      sawTerminalChunk: false,
      sawResponsesCompletedChunk: false,
      requiresResponsesTerminalEvent: false
    };
    const contractProbe: StreamContractProbeEnvelope = {
      probe: sseBody[STREAM_CONTRACT_PROBE_BODY_KEY] && typeof sseBody[STREAM_CONTRACT_PROBE_BODY_KEY] === 'object' && !Array.isArray(sseBody[STREAM_CONTRACT_PROBE_BODY_KEY])
        ? sseBody[STREAM_CONTRACT_PROBE_BODY_KEY] as Record<string, unknown>
        : undefined,
      emitted: false
    };
    terminalWatch.requiresResponsesTerminalEvent = Boolean(contractProbe.probe)
      && (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs');
    const effectiveResponsesRequestContext =
      (result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined)
      ?? options?.responsesRequestContext;
    let nativeSseConversationPersisted = false;
    const persistNativeSseConversationState = async (): Promise<void> => {
      if (nativeSseConversationPersisted) {
        return;
      }
      if (
        (entryEndpoint !== '/v1/responses'
          && entryEndpoint !== '/v1/responses.submit_tool_outputs')
        || !contractProbe.probe
        || typeof contractProbe.probe !== 'object'
        || Array.isArray(contractProbe.probe)
      ) {
        return;
      }
      nativeSseConversationPersisted = true;
      const conversationProviderKey = deriveResponsesConversationProviderKey(result.usageLogInfo);
      const sanitizedProbeBody = stripInternalKeysDeep(contractProbe.probe as Record<string, unknown>);
      await captureResponsesConversationToolCallRequestContext({
        entryEndpoint,
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        providerKey: conversationProviderKey,
        body: sanitizedProbeBody,
        requestContext: effectiveResponsesRequestContext,
      });
      await recordResponsesConversationToolCallResponse({
        entryEndpoint,
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        providerKey: conversationProviderKey,
        sessionId: result.usageLogInfo?.sessionId,
        conversationId: result.usageLogInfo?.conversationId,
        requestContext: effectiveResponsesRequestContext,
        body: sanitizedProbeBody
      });
      if (finishTracker.finishReason !== 'tool_calls') {
        await finalizeResponsesConversationNonToolResponse({
          entryEndpoint,
          requestLabel,
          timingRequestIds: result.usageLogInfo?.timingRequestIds,
          body: sanitizedProbeBody,
        });
      }
    };

    const readTimeoutMs = (names: string[], fallback: number): number => {
      for (const name of names) {
        const raw = String(process.env[name] || '').trim();
        if (!raw) {
          continue;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return fallback;
    };

    let totalTimeoutMs: number | undefined;
    for (const name of ['ROUTECODEX_HTTP_SSE_TIMEOUT_MS', 'RCC_HTTP_SSE_TIMEOUT_MS']) {
      const raw = String(process.env[name] || '').trim();
      if (!raw) {
        continue;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        totalTimeoutMs = parsed;
        break;
      }
    }
    const overrideSseTotalTimeoutMs = Number(options?.sseTotalTimeoutMs);
    if (Number.isFinite(overrideSseTotalTimeoutMs) && overrideSseTotalTimeoutMs > 0) {
      totalTimeoutMs = totalTimeoutMs === undefined
        ? overrideSseTotalTimeoutMs
        : Math.max(totalTimeoutMs, overrideSseTotalTimeoutMs);
    }

    const keepaliveMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_KEEPALIVE_MS', 'RCC_HTTP_SSE_KEEPALIVE_MS'],
      3_000
    );

    const detachOutboundStream = () => {
      try {
        outboundStream.unpipe(res);
      } catch (error) {
        logResponseNonBlockingError(`response.sse.unpipe:${requestLabel}`, error);
      }
    };

    const clearTimers = () => {
      if (totalTimer) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (terminalFlushTimer) {
        clearTimeout(terminalFlushTimer);
        terminalFlushTimer = null;
      }
      if (terminalAutoCloseTimer) {
        clearTimeout(terminalAutoCloseTimer);
        terminalAutoCloseTimer = null;
      }
    };

    const endWithSseError = (code: string, message: string) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimers();
      detachOutboundStream();
      logPipelineStage('response.sse.stream.timeout', requestLabel, { code, message });
      const payload = { type: 'error', status: 504, error: { message, code } };
      writeClientSseFrame(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, 'response.sse.timeout.write_error_event');
      try {
        res.end();
      } catch (error) {
        logResponseNonBlockingError(`response.sse.timeout.end:${requestLabel}`, error);
      }
      clientSseSnapshotRecorder?.flush();
      try {
        stream.destroy?.(Object.assign(new Error(message), { code }));
      } catch (error) {
        logResponseNonBlockingError(`response.sse.timeout.destroy_stream:${requestLabel}`, error);
      }
    };

    if (typeof totalTimeoutMs === 'number' && Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        endWithSseError('HTTP_SSE_TIMEOUT', `SSE timeout after ${totalTimeoutMs}ms`);
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }

    // Keep-alive: send SSE comments periodically so clients don't treat long servertool holds as a dead connection.
    // Comment frames (": ...") are ignored by SSE parsers and safe across OpenAI/Anthropic streams.
    // Emit one frame immediately so short client read deadlines are refreshed before first upstream token arrives.
    if (!ended) {
      writeClientSseFrame(`: keepalive\n\n`, 'response.sse.keepalive.initial_write');
    }
    if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (ended) {
          return;
        }
        writeClientSseFrame(`: keepalive\n\n`, 'response.sse.keepalive.write');
      }, keepaliveMs);
      keepaliveTimer.unref?.();
    }

    const cleanup = (trigger: 'close' | 'finish') => {
      if (cleanupLogged) {
        return;
      }
      cleanupLogged = true;
      clearTimers();
      detachOutboundStream();
      try {
        stream.destroy?.();
      } catch (error) {
        logResponseNonBlockingError(`response.sse.cleanup.destroy_stream:${requestLabel}`, error);
      }
      const closeBeforeStreamEnd = trigger === 'close' && !streamEnded && !finishTracker.seenTerminalEvent;
      const details = {
        status,
        trigger,
        streamEnded,
        sawTerminalEvent: finishTracker.seenTerminalEvent,
        finishReason: finishTracker.finishReason
      };
      if (closeBeforeStreamEnd) {
        logSseClientCloseDiagnosis(requestLabel, {
          ...details,
          closeBeforeStreamEnd
        });
        if (
          entryEndpoint === '/v1/responses'
          && contractProbe.probe
          && isToolCallContinuationResponse(contractProbe.probe)
        ) {
          preservedConversationOnClientClose = true;
          void persistNativeSseConversationState().catch((error) => {
            logResponseNonBlockingError(`responses-conversation-native-sse-client-close:${requestLabel}`, error);
          });
        } else {
          cleanupAbandonedResponsesConversation(requestLabel, {
            entryEndpoint,
            closeBeforeStreamEnd,
            timingRequestIds: result.usageLogInfo?.timingRequestIds
          });
        }
        logPipelineStage('response.sse.client_close', requestLabel, {
          ...details,
          closeBeforeStreamEnd
        });
      }
      logPipelineStage('response.sse.stream.end', requestLabel, details);
      logResponseCompleted({
        status,
        mode: 'sse',
        ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
      });
    };
    let ssePending = '';
    let clientWriteQueue = Promise.resolve();
    const responsesSseProjectionState: ResponsesSseClientProjectionState = {
      pendingApplyPatchArgumentDeltas: new Map(),
      applyPatchCallIds: new Set(),
      emittedApplyPatchDoneCallIds: new Set(),
    };
    const enqueueClientSseFrame = (frame: string, errorLabel: string) => {
      if (!frame.includes('apply_patch') && !frame.includes('function_call') && !frame.includes('required_action')) {
        writeClientSseFrame(frame, errorLabel, { recordSnapshot: false });
        return;
      }
      clientWriteQueue = clientWriteQueue
        .then(async () => normalizeResponsesSseFrameForClient(
          frame,
          entryEndpoint,
          effectiveResponsesRequestContext,
          responsesSseProjectionState
        ))
        .then((normalizedFrame) => {
          if (!normalizedFrame) {
            return;
          }
          writeClientSseFrame(normalizedFrame, errorLabel, { recordSnapshot: false });
        })
        .catch((error) => {
          logResponseNonBlockingError(`${errorLabel}:normalize:${requestLabel}`, error);
          writeClientSseFrame(frame, errorLabel, { recordSnapshot: false });
        });
    };
    outboundStream.on('data', (chunk: unknown) => {
      // SSE frames may span TCP chunk boundaries. Buffer partial frames
      // and only feed complete \n\n-delimited blocks to the probe/tracker.
      const text = typeof chunk === 'string' ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString('utf8')
        : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8')
        : '';
      if (!text) return;
      ssePending += text;
      const parts = ssePending.split(/\n\n/);
      ssePending = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const frame = `${part}\n\n`;
        maybeUpdateUsageLogInfoFromSseFrame(result, frame);
        updateSseTerminalTrackerFromChunk(part, finishTracker, terminalWatch);
        updateContractProbeFromSseChunk(part, contractProbe);
        enqueueClientSseFrame(frame, 'response.sse.stream.write_frame');
      }
      if (!terminalWatch.terminalSource || ended || streamEnded || terminalFlushTimer) {
        return;
      }
      terminalFlushTimer = setTimeout(() => {
        terminalFlushTimer = null;
        if (ended || streamEnded || res.writableEnded || res.destroyed) {
          return;
        }
        void persistNativeSseConversationState().catch((error) => {
          logResponseNonBlockingError(`responses-conversation-native-sse-terminal:${requestLabel}`, error);
        });
        if (!terminalAutoCloseTimer) {
          terminalAutoCloseTimer = setTimeout(() => {
            terminalAutoCloseTimer = null;
            if (ended || streamEnded || res.writableEnded || res.destroyed) {
              return;
            }
            void (async () => {
              const framesToWrite = buildResponsesTerminalSseFramesFromProbe(contractProbe.probe, requestLabel);
              if (framesToWrite.length > 0) {
                try {
                  for (const frame of framesToWrite) {
                    const normalizedFrame = await normalizeResponsesSseFrameForClient(
                      frame,
                      entryEndpoint,
                      effectiveResponsesRequestContext,
                      responsesSseProjectionState
                    );
                    if (normalizedFrame) {
                      writeClientSseFrame(normalizedFrame, 'response.sse.terminal.auto_close.write_terminal');
                    }
                  }
                finishTracker.seenTerminalEvent = true;
                terminalWatch.sawTerminalChunk = true;
                terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || framesToWrite.some((frame) => frame.includes('event: response.completed'));
                terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || framesToWrite.some((frame) => frame.includes('event: response.done'));
                terminalWatch.sawDoneChunk = terminalWatch.sawDoneChunk || framesToWrite.some((frame) => frame.includes('data: [DONE]'));
                contractProbe.emitted = true;
                } catch (repairWriteError) {
                  logResponseNonBlockingError(`response.sse.terminal.auto_close.write_terminal:${requestLabel}`, repairWriteError);
                }
                try {
                  stream.destroy?.();
                } catch (destroyError) {
                  logResponseNonBlockingError(`response.sse.terminal.auto_close.destroy_stream:${requestLabel}`, destroyError);
                }
                if (!res.writableEnded && !res.destroyed) {
                  try {
                    res.end();
                  } catch (endError) {
                    logResponseNonBlockingError(`response.sse.terminal.auto_close.end:${requestLabel}`, endError);
                  }
                  clientSseSnapshotRecorder?.flush();
                }
              }
            })().catch((error) => {
              logResponseNonBlockingError(`response.sse.terminal.auto_close:${requestLabel}`, error);
            });
          }, 120);
          terminalAutoCloseTimer.unref?.();
        }
      }, 25);
      terminalFlushTimer.unref?.();
    });
    outboundStream.on('error', (error: Error) => {
      ended = true;
      clearTimers();
      detachOutboundStream();
      getSessionExecutionStateTracker().recordSseClientClose(requestLabel, {
        finishReason: finishTracker.finishReason,
        terminal: finishTracker.seenTerminalEvent,
        closeBeforeStreamEnd: !streamEnded
      });
      logPipelineStage('response.sse.stream.error', requestLabel, { message: error.message });
      void clearResponsesConversationRequestIds({
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        reason: 'sse-stream-error',
      });
      logResponseCompleted({
        status: 500,
        mode: 'sse',
        reason: 'stream_error',
        ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
      });
      try {
        const clientVisibleMessage = error.message.startsWith('[server.response_projection]')
          ? 'SSE stream response projection failed'
          : error.message;
        const payload = {
          type: 'error',
          status: 500,
          error: {
            message: clientVisibleMessage,
            code: 'sse_stream_error',
            request_id: requestLabel
          }
        };
        writeClientSseFrame(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, 'response.sse.stream_error.write_error_event');
      } catch (writeError) {
        logResponseNonBlockingError(`response.sse.stream_error.write_error_event:${requestLabel}`, writeError);
      }
      try {
        res.end();
      } catch (endError) {
        logResponseNonBlockingError(`response.sse.stream_error.end:${requestLabel}`, endError);
      }
      clientSseSnapshotRecorder?.flush(error);
    });
    outboundStream.on('end', async () => {
      ended = true;
      streamEnded = true;
      clearTimers();
      const resolvedStreamFinishReason =
        finishTracker.finishReason
        || (typeof result.usageLogInfo?.finishReason === 'string' && result.usageLogInfo.finishReason.trim()
          ? result.usageLogInfo.finishReason.trim()
          : undefined);
      finishTracker.finishReason = resolvedStreamFinishReason;
      finishTracker.seenTerminalEvent = terminalWatch.sawTerminalChunk;
      if (!resolvedStreamFinishReason) {
        logPipelineStage('response.sse.finish_reason.missing', requestLabel, {
          status,
          mode: 'sse',
          reason: 'missing_bridge_finish_reason'
        });
      }
      getSessionExecutionStateTracker().recordSseStreamEnd(requestLabel, {
        finishReason: resolvedStreamFinishReason,
        terminal: finishTracker.seenTerminalEvent
      });
      if (ssePending.trim()) {
        const pendingFrame = `${ssePending}\n\n`;
        maybeUpdateUsageLogInfoFromSseFrame(result, pendingFrame);
        updateSseTerminalTrackerFromChunk(ssePending, finishTracker, terminalWatch);
        updateContractProbeFromSseChunk(ssePending, contractProbe);
        enqueueClientSseFrame(pendingFrame, 'response.sse.stream.write_pending_frame');
        ssePending = '';
      }
      try {
        await clientWriteQueue;
      } catch (error) {
        logResponseNonBlockingError(`response.sse.stream.end.flush_queue:${requestLabel}`, error);
      }
      if (!completedLogged) {
        completedLogged = true;
        logStreamRequestComplete(entryEndpoint, requestLabel, status, resolvedStreamFinishReason, requestLogContext);
      }
      const repairedTerminalFrames = !terminalWatch.sawResponsesCompletedChunk || !terminalWatch.sawResponsesDoneEvent || !terminalWatch.sawDoneChunk
        ? buildResponsesTerminalSseFramesFromProbe(contractProbe.probe, requestLabel)
        : [];
      if (repairedTerminalFrames.length > 0 && !res.writableEnded && !res.destroyed) {
        try {
          const framesToWrite = repairedTerminalFrames;
          for (const frame of framesToWrite) {
            const normalizedFrame = await normalizeResponsesSseFrameForClient(
              frame,
              entryEndpoint,
              effectiveResponsesRequestContext,
              responsesSseProjectionState
            );
            if (normalizedFrame) {
              writeClientSseFrame(normalizedFrame, 'response.sse.stream.end.write_terminal_probe');
            }
          }
          if (framesToWrite.length > 0) {
            finishTracker.seenTerminalEvent = true;
            terminalWatch.sawTerminalChunk = true;
            terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || framesToWrite.some((frame) => frame.includes('event: response.completed'));
            terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || framesToWrite.some((frame) => frame.includes('event: response.done'));
            terminalWatch.sawDoneChunk = terminalWatch.sawDoneChunk || framesToWrite.some((frame) => frame.includes('data: [DONE]'));
            contractProbe.emitted = true;
          }
        } catch (repairWriteError) {
          logResponseNonBlockingError(`response.sse.stream.end.write_terminal_probe:${requestLabel}`, repairWriteError);
        }
      }
      if (finishTracker.seenTerminalEvent && !terminalWatch.sawDoneChunk && !res.writableEnded && !res.destroyed) {
        try {
          writeClientSseFrame('data: [DONE]\n\n', 'response.sse.stream.end.write_done_after_terminal');
          terminalWatch.sawDoneChunk = true;
        } catch (doneWriteError) {
          logResponseNonBlockingError(`response.sse.stream.end.write_done_after_terminal:${requestLabel}`, doneWriteError);
        }
      }
      void persistNativeSseConversationState()
        .catch((error) => {
          logResponseNonBlockingError(`responses-conversation-native-sse:${requestLabel}`, error);
        })
        .finally(async () => {
          const closedBeforeTerminalEvent = !finishTracker.seenTerminalEvent;
          if (closedBeforeTerminalEvent && !preservedConversationOnClientClose) {
            logPipelineStage('response.sse.stream.error', requestLabel, {
              message: 'stream closed before response.completed',
              code: 'upstream_stream_incomplete'
            });
            void clearResponsesConversationRequestIds({
              requestLabel,
              timingRequestIds: result.usageLogInfo?.timingRequestIds,
              reason: 'sse-incomplete',
            });
            if (!res.writableEnded && !res.destroyed) {
              try {
                await clientWriteQueue;
                const payload = {
                  type: 'error',
                  status: 502,
                  error: {
                    message: 'stream closed before response.completed',
                    code: 'upstream_stream_incomplete',
                    request_id: requestLabel
                  }
                };
                writeClientSseFrame(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, 'response.sse.stream.end.write_error_event');
              } catch (writeError) {
                logResponseNonBlockingError(`response.sse.stream.end.write_error_event:${requestLabel}`, writeError);
              }
            }
          }
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.end();
            } catch (endError) {
              logResponseNonBlockingError(`response.sse.stream.end:${requestLabel}`, endError);
            }
            clientSseSnapshotRecorder?.flush();
          }
        });
    });
    res.on('close', () => {
      if (!streamEnded) {
        getSessionExecutionStateTracker().recordSseClientClose(requestLabel, {
          finishReason: finishTracker.finishReason,
          terminal: finishTracker.seenTerminalEvent,
          closeBeforeStreamEnd: true
        });
      }
      cleanup('close');
    });
    res.on('finish', () => cleanup('finish'));
    return Promise.resolve();
  }

  applyHeaders(res, result.headers, false);
  if (body === undefined || body === null) {
    if (status >= 400) {
      await clearResponsesConversationRequestIds({
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        reason: 'json-empty-error',
      });
    }
    logPipelineStage('response.json.empty', requestLabel, { status });
    if (shouldCaptureClientResponseSnapshotStage('client-response')) {
      void writeServerSnapshot({
        phase: 'client-response',
        requestId: requestLabel,
        entryEndpoint,
        data: { status, headers: result.headers, body: null }
      }).catch((error) => {
        logResponseNonBlockingError(`writeServerSnapshot:json_empty:${requestLabel}`, error);
      });
    }
    res.status(status).end();
    logPipelineStage('response.json.completed', requestLabel, { status });
    logResponseCompleted({ status, mode: 'json', empty: true });
    return Promise.resolve();
  }
  logPipelineStage('response.json.write', requestLabel, { status });
  // E1 boundary rule: internal env variables use "__*" and must never reach client payloads.
  // Preserve the SSE carrier key (it is handled above and never JSON-encoded).
  const normalizedJsonBody = await normalizeResponsesToolCallsForClientBody(
    normalizeResponsesJsonBody(body, entryEndpoint, requestLabel),
    entryEndpoint,
    result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined
      ?? options?.responsesRequestContext
  );
  const usageNormalized = normalizeChatUsagePayload(normalizedJsonBody, {
    entryEndpoint,
    usageFallback: result.usageLogInfo?.usage
  });
  if (usageNormalized.normalized) {
    logPipelineStage('response.chat_usage.normalized', requestLabel, {
      source: usageNormalized.source
    });
  }
  const clientBody = usageNormalized.payload;
  assertClientResponseHasNoInternalCarriers(clientBody, requestLabel);
  const sanitized = stripInternalKeysDeep(clientBody);
  if (status >= 400) {
    await clearResponsesConversationRequestIds({
      requestLabel,
      timingRequestIds: result.usageLogInfo?.timingRequestIds,
      responseId: readResponsesConversationResponseId(sanitized),
      reason: 'json-error',
    });
  }
  const jsonFinishReason = deriveFinishReason(clientBody);
  const conversationProviderKey = deriveResponsesConversationProviderKey(result.usageLogInfo);
  await captureResponsesConversationToolCallRequestContext({
    entryEndpoint,
    requestLabel,
    timingRequestIds: result.usageLogInfo?.timingRequestIds,
    providerKey: conversationProviderKey,
    body: sanitized,
    requestContext: options?.responsesRequestContext,
  });
  await recordResponsesConversationToolCallResponse({
    entryEndpoint,
    requestLabel,
    timingRequestIds: result.usageLogInfo?.timingRequestIds,
    providerKey: conversationProviderKey,
    sessionId: result.usageLogInfo?.sessionId,
    conversationId: result.usageLogInfo?.conversationId,
    requestContext: options?.responsesRequestContext,
    body: sanitized
  });
  await finalizeResponsesConversationNonToolResponse({
    entryEndpoint,
    requestLabel,
    timingRequestIds: result.usageLogInfo?.timingRequestIds,
    body: sanitized,
  });
  getSessionExecutionStateTracker().recordJsonResponseComplete(requestLabel, jsonFinishReason);
  if (shouldCaptureClientResponseSnapshotStage('client-response')) {
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: requestLabel,
      entryEndpoint,
      data: { status, headers: result.headers, body: sanitized }
    }).catch((error) => {
      logResponseNonBlockingError(`writeServerSnapshot:json_payload:${requestLabel}`, error);
    });
  }
  assertClientResponseHasNoInternalCarriers(sanitized, requestLabel);
  res.status(status).json(sanitized);
  logPipelineStage('response.json.completed', requestLabel, { status });
  logResponseCompleted({
    status,
    mode: 'json',
    ...(jsonFinishReason ? { finishReason: jsonFinishReason } : {})
  });
}

function applyHeaders(res: Response, headers: Record<string, string> | undefined, omitContentType: boolean): void {
  if (!headers) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = key.toLowerCase();
    if (BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    if (omitContentType && normalized === 'content-type') {
      continue;
    }
    res.setHeader(key, value);
  }
}

function toNodeReadable(streamLike: unknown): Readable | null {
  if (!streamLike) {
    return null;
  }
  if (streamLike instanceof Readable) {
    return streamLike;
  }
  const pipeCandidate = streamLike as PipeCapable;
  if (pipeCandidate && typeof pipeCandidate.pipe === 'function') {
    return streamLike as Readable;
  }
  const webCandidate = streamLike as WebReadable;
  if (webCandidate && typeof webCandidate.getReader === 'function') {
    try {
      return Readable.fromWeb(streamLike as NodeReadableStream);
    } catch (error) {
      logResponseNonBlockingError('toNodeReadable.fromWeb', error);
      return null;
    }
  }
  const asyncIterable = streamLike as AsyncIterableLike;
  if (asyncIterable && typeof asyncIterable[Symbol.asyncIterator] === 'function') {
    return Readable.from(streamLike as AsyncIterable<unknown>);
  }
  return null;
}

function shouldCaptureClientResponseSnapshotStage(stage: 'client-response' | 'client-response.error'): boolean {
  return isSnapshotsEnabled() && shouldCaptureSnapshotStage(stage);
}

function maybeAttachClientSseSnapshotStream(
  stream: NodeJS.ReadableStream,
  recorder?: ClientSseSnapshotRecorder
): NodeJS.ReadableStream {
  stream.on('data', (chunk: unknown) => recorder?.record(chunk));
  stream.on('error', (error: unknown) => recorder?.flush(error));

  return stream;
}

function createClientSseSnapshotRecorder(
  stream: NodeJS.ReadableStream,
  res: Response,
  options: {
    requestId: string;
    entryEndpoint?: string;
    status: number;
    headers?: Record<string, string>;
  }
): ClientSseSnapshotRecorder {
  let flushed = false;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  const maxCaptureBytes = 256 * 1024;

  const record = (chunk: unknown) => {
    if (capturedBytes >= maxCaptureBytes) {
      return;
    }
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!buf || buf.length === 0) {
      return;
    }
    const remaining = Math.max(0, maxCaptureBytes - capturedBytes);
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    chunks.push(slice);
    capturedBytes += slice.length;
  };

  const flush = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      res.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    } catch (removeError) {
      logResponseNonBlockingError(`client-sse-snapshot.removeListener:${options.requestId}`, removeError);
    }
    const payload: Record<string, unknown> = {
      mode: 'sse',
      status: options.status,
      headers: options.headers,
      bodyText: Buffer.concat(chunks).toString('utf8'),
      truncated: capturedBytes >= maxCaptureBytes
    };
    if (error) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      data: payload
    }).catch((snapshotError) => {
      logResponseNonBlockingError(`writeServerSnapshot:sse_payload:${options.requestId}`, snapshotError);
    });
  };

  const onFinish = () => flush();
  const onClose = () => flush();
  const onEnd = () => flush();
  const onError = (error: unknown) => flush(error);

  res.on('finish', onFinish);
  res.on('close', onClose);
  res.on('end', onEnd);
  stream.on('error', onError);

  return { record, flush };
}
