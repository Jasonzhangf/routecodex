
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
      const nestedMetadata = findForbiddenFieldInResponsePayload(value, seen, depth + 1);
      if (nestedMetadata) {
        return nestedMetadata === 'metadata' ? key : nestedMetadata;
      }
      continue;
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
import { isClientDisconnectAbortError } from '../runtime/http-server/executor-provider.js';
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
  sawAssistantMessageDoneTerminal?: boolean;
  requiresResponsesTerminalEvent?: boolean;
  terminalSource?: string;
  pendingTerminalEvent?: 'response.completed' | 'response.done' | 'response.error' | 'response.cancelled' | 'response.failed';
};

type StreamCompletionLogState = {
  logged: boolean;
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
  pendingApplyPatchArgumentDeltas: Record<string, string>;
  applyPatchCallIds: string[];
  emittedApplyPatchDoneCallIds: string[];
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

function buildClientSseKeepaliveFrame(entryEndpoint?: string): string {
  const commentFrame = ': keepalive\n\n';
  if (
    entryEndpoint === '/v1/responses'
    || entryEndpoint === '/v1/responses.submit_tool_outputs'
  ) {
    return `${commentFrame}event: ping\ndata: {"type":"ping"}\n\n`;
  }
  return commentFrame;
}

function shouldDropClientSseFrame(frame: string, entryEndpoint?: string): boolean {
  return (
    (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs') &&
    frame.trim() === 'data: [DONE]'
  );
}

function assertClientSseFrameHasNoInternalCarriers(frame: string, requestId: string): void {
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const dataText = line.slice(5).trim();
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      continue;
    }
    assertClientResponseHasNoInternalCarriers(parsed, requestId);
  }
}

const RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'error',
  'ping',
  'response.queued',
  'response.created',
  'response.in_progress',
  'response.incomplete',
  'response.completed',
  'response.failed',
  'response.cancelled',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.annotation.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.audio.delta',
  'response.audio.done',
  'response.audio.transcript.delta',
  'response.audio.transcript.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed',
  'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning.delta',
  'response.reasoning.done',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.generating',
  'response.image_generation_call.partial_image',
  'response.image_generation_call.completed',
  'response.mcp_call.in_progress',
  'response.mcp_call_arguments.delta',
  'response.mcp_call_arguments.done',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'response.mcp_list_tools.in_progress',
  'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed',
]);

function assertDirectPassthroughSseFrameUsesResponsesProtocol(frame: string, requestId: string): void {
  const eventNames = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .filter(Boolean);
  for (const eventName of eventNames) {
    if (!RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS.has(eventName)) {
      throw Object.assign(
        new Error(`[server.response_projection] direct passthrough SSE emitted non-Responses event "${eventName}" (requestId=${requestId})`),
        { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' }
      );
    }
  }
}

function isDirectPassthroughTransportKeepaliveFrame(frame: string): boolean {
  const trimmed = frame.trim();
  if (!trimmed) {
    return false;
  }
  const lines = trimmed.split(/\r?\n/);
  const eventNames = lines
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .filter(Boolean);
  if (eventNames.length !== 1 || eventNames[0] !== 'keepalive') {
    return false;
  }
  return lines.every((line) => {
    if (!line) {
      return true;
    }
    return line.startsWith('event:') || line.startsWith('data:') || line.startsWith(':');
  });
}

function isResponsesRequiredActionFrame(frame: string): boolean {
  return frame.split(/\r?\n/).some((line) => {
    if (!line.startsWith('data:')) {
      return false;
    }
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') {
      return false;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return parsed.type === 'response.required_action';
    } catch {
      return false;
    }
  });
}

function assertDirectPassthroughSseFrameHasNoInternalMetadataControls(frame: string, requestId: string): void {
  assertDirectPassthroughSseFrameUsesResponsesProtocol(frame, requestId);
  if (isResponsesRequiredActionFrame(frame)) {
    throw Object.assign(
      new Error(`[server.response_projection] direct passthrough SSE must not rewrite response.required_action into output_item/function_call frames (requestId=${requestId})`),
      { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' }
    );
  }
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const dataText = line.slice(5).trim();
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const stack: unknown[] = [parsed];
    const seen = new WeakSet<object>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        continue;
      }
      if (seen.has(current as object)) {
        continue;
      }
      seen.add(current as object);
      const record = current as Record<string, unknown>;
      const metadata = record.metadata;
      if (metadata !== undefined) {
        if (isInternalMetadataCarrier(metadata)) {
          throw new Error(
            `[server.response_projection] direct passthrough SSE metadata contains internal control fields (requestId=${requestId})`
          );
        }
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
          stack.push(metadata);
        }
      }
      for (const [key, value] of Object.entries(record)) {
        if (key === 'metadata') {
          continue;
        }
        if (CLIENT_RESPONSE_FORBIDDEN_FIELDS.has(key)) {
          throw new Error(
            `[server.response_projection] client response contains internal carrier field "${key}" (requestId=${requestId})`
          );
        }
        if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
  }
}

type ChatUsageNormalizationResult = {
  payload: unknown;
  normalized: boolean;
  source?: 'body' | 'usage_log';
};


const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';
const DEFAULT_SSE_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_SSE_PROJECTION_TIMEOUT_MS = 5_000;
const DEFAULT_SSE_TERMINAL_CLOSE_TIMEOUT_MS = 1_500;

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function withSseClientProjectionTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  requestLabel: string,
  stage: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(
        new Error(`[server.response_projection] SSE client projection timed out after ${timeoutMs}ms (${stage}, requestId=${requestLabel})`),
        { code: 'SSE_CLIENT_PROJECTION_TIMEOUT' }
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

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
  return entryEndpoint === '/v1/responses' && Boolean(requestContext);
}

async function recordResponsesConversationToolCallResponse(args: {
  entryEndpoint?: string;
  requestLabel: string;
  timingRequestIds?: string[];
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  sessionId?: unknown;
  conversationId?: unknown;
  requestContext?: DispatchOptions['responsesRequestContext'];
  body: unknown;
}): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    logResponsesContinuationTrace('record.skip.endpoint', args.requestLabel, {
      entryEndpoint: args.entryEndpoint ?? 'unknown'
    });
    return;
  }
  if (!shouldPersistResponsesToolCallContinuationRecord(args.entryEndpoint, args.requestContext)) {
    logResponsesContinuationTrace('record.skip.persist_policy', args.requestLabel, {
      entryEndpoint: args.entryEndpoint ?? 'unknown',
      hasRequestContext: Boolean(args.requestContext)
    });
    return;
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    logResponsesContinuationTrace('record.skip.body', args.requestLabel, {
      reason: 'non_object_body'
    });
    return;
  }
  if (!isToolCallContinuationResponse(args.body)) {
    logResponsesContinuationTrace('record.skip.non_continuation', args.requestLabel, {
      responseId: readResponsesConversationResponseId(args.body),
      finishReason: deriveFinishReason(args.body) ?? undefined
    });
    return;
  }
  const recordBody = args.body as Record<string, unknown>;
  const responseId = readResponsesConversationResponseId(recordBody);
  logResponsesContinuationTrace('record.start', args.requestLabel, {
    responseId,
    continuationOwner: args.continuationOwner,
    providerKey: args.providerKey
  });
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
      continuationOwner: args.continuationOwner,
      matchedPort: args.requestContext?.matchedPort,
      routingPolicyGroup: args.requestContext?.routingPolicyGroup,
    }).catch((error) => {
      logResponsesContinuationTrace('record.error', args.requestLabel, {
        recordRequestId,
        responseId,
        message: error instanceof Error ? error.message : String(error ?? 'unknown')
      });
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
      logResponsesContinuationTrace('record.finalize_error', args.requestLabel, {
        retainRequestId,
        responseId,
        message: error instanceof Error ? error.message : String(error ?? 'unknown')
      });
      logResponseNonBlockingError(`responses-conversation-finalize:${retainRequestId}`, error);
    });
  }
  logResponsesContinuationTrace('record.done', args.requestLabel, {
    responseId,
    retainedRequestIds: retainRequestIds
  });
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
  if (!args.requestContext) {
    logResponsesContinuationTrace('capture.skip.no_request_context', args.requestLabel, {
      entryEndpoint: args.entryEndpoint ?? 'unknown'
    });
    return;
  }
  if (!shouldPersistResponsesToolCallContinuationRecord(args.entryEndpoint, args.requestContext)) {
    logResponsesContinuationTrace('capture.skip.persist_policy', args.requestLabel, {
      entryEndpoint: args.entryEndpoint ?? 'unknown'
    });
    return;
  }
  const requestPayload =
    args.requestContext.payload && typeof args.requestContext.payload === 'object' && !Array.isArray(args.requestContext.payload)
      ? (args.requestContext.payload as Record<string, unknown>)
      : undefined;
  if (!isToolCallContinuationResponse(args.body)) {
    logResponsesContinuationTrace('capture.skip.non_continuation', args.requestLabel, {
      responseId: readResponsesConversationResponseId(args.body),
      finishReason: deriveFinishReason(args.body) ?? undefined
    });
    return;
  }
  const body = args.body && typeof args.body === 'object' && !Array.isArray(args.body)
    ? args.body as Record<string, unknown>
    : undefined;
  const responseId = readResponsesConversationResponseId(body);
  const ids = resolveResponsesConversationRecordRequestIds(
    args.requestLabel,
    args.timingRequestIds,
    responseId
  );
  logResponsesContinuationTrace('capture.start', args.requestLabel, {
    responseId,
    requestIds: ids,
    providerKey: args.providerKey
  });
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
      logResponsesContinuationTrace('capture.error', args.requestLabel, {
        captureRequestId: requestId,
        responseId,
        message: error instanceof Error ? error.message : String(error ?? 'unknown')
      });
      logResponseNonBlockingError(`responses-conversation-capture:${requestId}`, error);
    });
  }
  logResponsesContinuationTrace('capture.done', args.requestLabel, {
    responseId,
    requestIds: ids
  });
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

function logResponsesContinuationTrace(
  stage: string,
  requestLabel: string,
  details?: Record<string, unknown>
): void {
  if ((process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() !== '1') {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    console.warn(`[responses-continuation] ${stage} request=${requestLabel}${suffix}`);
  } catch {
    console.warn(`[responses-continuation] ${stage} request=${requestLabel}`);
  }
}

function summarizeSseFrameForLog(frame: string): Record<string, unknown> | null {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  const summary: Record<string, unknown> = {};
  if (eventName) {
    summary.event = eventName;
  }
  if (!dataText || dataText === '[DONE]') {
    if (dataText === '[DONE]') {
      summary.done = true;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  }
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      summary.dataKind = typeof parsed;
      return summary;
    }
    const record = parsed as Record<string, unknown>;
    const response =
      record.response && typeof record.response === 'object' && !Array.isArray(record.response)
        ? (record.response as Record<string, unknown>)
        : undefined;
    const requiredAction =
      (record.required_action && typeof record.required_action === 'object' && !Array.isArray(record.required_action)
        ? record.required_action
        : undefined)
      ?? (response?.required_action && typeof response.required_action === 'object' && !Array.isArray(response.required_action)
        ? response.required_action
        : undefined);
    const output =
      Array.isArray(record.output) ? record.output
      : Array.isArray(response?.output) ? response.output
      : [];
    const functionCallCount = output.filter((item) => {
      return item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call';
    }).length;
    const requiredToolCalls =
      requiredAction
      && typeof requiredAction === 'object'
      && !Array.isArray(requiredAction)
      && typeof (requiredAction as Record<string, unknown>).submit_tool_outputs === 'object'
      && !Array.isArray((requiredAction as Record<string, unknown>).submit_tool_outputs)
      && Array.isArray(((requiredAction as Record<string, unknown>).submit_tool_outputs as Record<string, unknown>).tool_calls)
        ? (((requiredAction as Record<string, unknown>).submit_tool_outputs as Record<string, unknown>).tool_calls as unknown[]).length
        : undefined;
    if (typeof record.type === 'string') {
      summary.type = record.type;
    }
    if (typeof record.status === 'string') {
      summary.status = record.status;
    } else if (typeof response?.status === 'string') {
      summary.status = response.status;
    }
    if (typeof record.finish_reason === 'string') {
      summary.finishReason = record.finish_reason;
    } else if (typeof response?.finish_reason === 'string') {
      summary.finishReason = response.finish_reason;
    }
    if (requiredAction) {
      summary.hasRequiredAction = true;
    }
    if (requiredToolCalls !== undefined) {
      summary.requiredToolCalls = requiredToolCalls;
    }
    if (functionCallCount > 0) {
      summary.outputFunctionCalls = functionCallCount;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    summary.dataParse = 'non_json';
    return summary;
  }
}

function logSseFrameProjection(
  requestLabel: string,
  stage: string,
  frame: string
): void {
  const summary = summarizeSseFrameForLog(frame);
  if (!summary) {
    return;
  }
  logPipelineStage(stage, requestLabel, summary);
}

function writeSseDiagnosticSnapshot(
  requestLabel: string,
  entryEndpoint: string | undefined,
  reason: string,
  data: Record<string, unknown>
): void {
  if (!shouldCaptureClientResponseSnapshotStage('client-response.error')) {
    return;
  }
  void writeServerSnapshot({
    phase: 'client-response.error',
    requestId: requestLabel,
    entryEndpoint,
    data: {
      mode: 'sse',
      reason,
      ...data
    }
  }).catch((error) => {
    logResponseNonBlockingError(`writeServerSnapshot:sse_diagnostic:${requestLabel}:${reason}`, error);
  });
}

function createSseClientResponseClosedError(): Error & { code: string; name: string; retryable: boolean } {
  return Object.assign(new Error('CLIENT_RESPONSE_CLOSED'), {
    code: 'CLIENT_DISCONNECTED',
    name: 'AbortError',
    retryable: false
  });
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
  context?: Record<string, unknown>
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

function logStreamRequestCompleteOnce(
  state: StreamCompletionLogState,
  endpoint: string | undefined,
  requestLabel: string,
  status: number,
  finishReason?: string,
  context?: Record<string, unknown>
): void {
  if (state.logged) {
    return;
  }
  state.logged = true;
  logStreamRequestComplete(endpoint, requestLabel, status, finishReason, context);
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


function createClientVisibleSseProjectionStream(
  stream: Readable,
  requestId: string
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
          assertClientResponseHasNoInternalCarriers(parsed, requestId);
          this.push(frame);
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

function createDirectPassthroughSseGuardStream(
  stream: Readable,
  requestId: string
): Readable {
  let pending = '';
  const pushReadyFrames = (target: Transform) => {
    let boundary = /\r?\n\r?\n/.exec(pending);
    while (boundary) {
      const frameEnd = boundary.index + boundary[0].length;
      const frame = pending.slice(0, frameEnd);
      pending = pending.slice(frameEnd);
      if (isDirectPassthroughTransportKeepaliveFrame(frame)) {
        boundary = /\r?\n\r?\n/.exec(pending);
        continue;
      }
      assertDirectPassthroughSseFrameHasNoInternalMetadataControls(frame, requestId);
      target.push(frame);
      boundary = /\r?\n\r?\n/.exec(pending);
    }
  };
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
        pushReadyFrames(this);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (pending) {
          if (isDirectPassthroughTransportKeepaliveFrame(pending)) {
            pending = '';
            callback();
            return;
          }
          assertDirectPassthroughSseFrameHasNoInternalMetadataControls(pending, requestId);
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

  if (text.includes('data: [DONE]') && !terminalWatch.requiresResponsesTerminalEvent) {
    finishTracker.seenTerminalEvent = true;
    terminalWatch.sawTerminalChunk = true;
    terminalWatch.terminalSource = terminalWatch.terminalSource ?? '[DONE]';
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
      const parsedItem =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>).item as Record<string, unknown> | undefined)
          : undefined;
      if (
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.failed'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
      ) {
        terminalWatch.pendingTerminalEvent = parsedType as SseTerminalWatch['pendingTerminalEvent'];
      }
      const derived = deriveFinishReason(parsed);
      if (!derived) {
        const itemType = typeof parsedItem?.type === 'string' ? parsedItem.type.trim() : '';
        const itemRole = typeof parsedItem?.role === 'string' ? parsedItem.role.trim() : '';
        const itemStatus = typeof parsedItem?.status === 'string' ? parsedItem.status.trim().toLowerCase() : '';
        if (
          parsedType === 'response.output_item.done'
          && itemType === 'message'
          && itemRole === 'assistant'
          && itemStatus === 'completed'
        ) {
          terminalWatch.sawTerminalChunk = true;
          terminalWatch.sawAssistantMessageDoneTerminal = true;
          terminalWatch.terminalSource = terminalWatch.terminalSource ?? parsedType;
        }
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
        terminalWatch.terminalSource = terminalWatch.terminalSource ?? eventName ?? parsedType;
      }
      if (
        parsedType === 'response.output_item.done'
        && typeof parsedItem?.type === 'string'
        && parsedItem.type.trim() === 'message'
        && typeof parsedItem?.role === 'string'
        && parsedItem.role.trim() === 'assistant'
        && typeof parsedItem?.status === 'string'
        && parsedItem.status.trim().toLowerCase() === 'completed'
      ) {
        terminalWatch.sawTerminalChunk = true;
        terminalWatch.sawAssistantMessageDoneTerminal = true;
        terminalWatch.terminalSource = terminalWatch.terminalSource ?? parsedType;
      }
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
      .find((name) => name === 'response.completed' || name === 'response.done' || name === 'response.failed' || name === 'response.error' || name === 'response.cancelled');
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
  requestContext?: DispatchOptions['responsesRequestContext'],
  metadata?: Record<string, unknown>
): Promise<unknown> {
  if (metadata?.__routecodexDirectPassthrough === true) {
    return body;
  }
  if (
    entryEndpoint !== '/v1/responses'
    && entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return body;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || hasSsePayload(body)) {
    return body;
  }
  if (!(body as Record<string, unknown>).required_action) {
    return body;
  }
  const mod = await importCoreDist<{ projectResponsesClientPayloadForClientWithNative?: (payload: unknown, toolsRaw: unknown[], metadata?: Record<string, unknown>) => Record<string, unknown> }>(
    'native/router-hotpath/native-hub-pipeline-resp-semantics'
  );
  if (typeof mod.projectResponsesClientPayloadForClientWithNative !== 'function') {
    throw new Error('[handler-response] projectResponsesClientPayloadForClientWithNative not available');
  }
  return mod.projectResponsesClientPayloadForClientWithNative(body, readResponsesClientToolsRaw(requestContext), metadata);
}

async function normalizeResponsesSseFrameForClient(
  frame: string,
  entryEndpoint?: string,
  requestContext?: DispatchOptions['responsesRequestContext'],
  metadata?: Record<string, unknown>,
  projectionState?: ResponsesSseClientProjectionState,
  requestLabel = 'unknown'
): Promise<string> {
  if (metadata?.__routecodexDirectPassthrough === true) {
    return frame;
  }
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
  if (!eventName.startsWith('response.')) {
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
  if (eventName !== 'response.required_action' && !dataText.includes('"required_action"')) {
    return frame;
  }
  if (eventName === 'response.required_action') {
    return buildResponsesTerminalSseFramesFromProbe(data, requestLabel).join('');
  }
  const mod = await importCoreDist<{
    projectResponsesSseFrameForClientWithNative?: (input: {
      frame: string;
      eventName?: string;
      data: Record<string, unknown>;
      toolsRaw: unknown[];
      metadata?: Record<string, unknown>;
      state: ResponsesSseClientProjectionState;
    }) => { emit: boolean; frame: string; state: ResponsesSseClientProjectionState };
  }>('native/router-hotpath/native-hub-pipeline-resp-semantics');
  if (typeof mod.projectResponsesSseFrameForClientWithNative !== 'function') {
    throw new Error('[handler-response] projectResponsesSseFrameForClientWithNative not available');
  }
  const projected = mod.projectResponsesSseFrameForClientWithNative({
    frame,
    eventName,
    data,
    toolsRaw: readResponsesClientToolsRaw(requestContext),
    metadata,
    state: projectionState ?? {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    },
  });
  if (projectionState) {
    projectionState.pendingApplyPatchArgumentDeltas = projected.state.pendingApplyPatchArgumentDeltas ?? {};
    projectionState.applyPatchCallIds = projected.state.applyPatchCallIds ?? [];
    projectionState.emittedApplyPatchDoneCallIds = projected.state.emittedApplyPatchDoneCallIds ?? [];
  }
  return projected.emit ? projected.frame : '';
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
          ?? args.responsesRequestContext,
        args.result.metadata
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildRequestLogContext(result: PipelineExecutionResult): Record<string, unknown> {
  const metadata = asRecord(result.metadata);
  const usageLogInfo = result.usageLogInfo;
  return {
    logSessionColorKey: usageLogInfo?.logSessionColorKey ?? metadata.logSessionColorKey,
    clientTmuxSessionId: usageLogInfo?.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
    client_tmux_session_id: usageLogInfo?.client_tmux_session_id ?? metadata.client_tmux_session_id,
    tmuxSessionId: usageLogInfo?.tmuxSessionId ?? metadata.tmuxSessionId,
    tmux_session_id: usageLogInfo?.tmux_session_id ?? metadata.tmux_session_id,
    rccSessionClientTmuxSessionId:
      usageLogInfo?.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
    rcc_session_client_tmux_session_id:
      usageLogInfo?.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
    sessionId: usageLogInfo?.sessionId ?? metadata.sessionId,
    session_id: usageLogInfo?.session_id ?? metadata.session_id,
    conversationId: usageLogInfo?.conversationId ?? metadata.conversationId,
    conversation_id: usageLogInfo?.conversation_id ?? metadata.conversation_id
  };
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
  const requestLogContext = buildRequestLogContext(result);
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
      const externalLatencyStartedAtMs = usageLogInfo.externalLatencyStartedAtMs;
      const shouldUseExternalLatencyStartedAt =
        details?.mode === 'sse'
        && typeof externalLatencyStartedAtMs === 'number'
        && Number.isFinite(externalLatencyStartedAtMs)
        && externalLatencyStartedAtMs > 0;
      const externalLatencyMs =
        shouldUseExternalLatencyStartedAt
          ? Math.max(0, Date.now() - externalLatencyStartedAtMs)
          : usageLogInfo.externalLatencyMs;
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
        externalLatencyMs,
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
        logSessionColorKey: requestLogContext.logSessionColorKey,
        clientTmuxSessionId: requestLogContext.clientTmuxSessionId,
        client_tmux_session_id: requestLogContext.client_tmux_session_id,
        tmuxSessionId: requestLogContext.tmuxSessionId,
        tmux_session_id: requestLogContext.tmux_session_id,
        rccSessionClientTmuxSessionId: requestLogContext.rccSessionClientTmuxSessionId,
        rcc_session_client_tmux_session_id: requestLogContext.rcc_session_client_tmux_session_id,
        sessionId: requestLogContext.sessionId,
        session_id: requestLogContext.session_id,
        conversationId: requestLogContext.conversationId,
        conversation_id: requestLogContext.conversation_id,
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

  logPipelineStage('response.dispatch.start', requestLabel, {
    status,
    stream: expectsStream,
    forced: forceSSE,
    entryEndpoint,
    hasSsePayload: hasSsePayload(body),
    directPassthrough: result.metadata?.__routecodexDirectPassthrough === true,
  });

  if (expectsStream) {
    const sseBody = body as SsePayloadShape & Record<string, unknown>;
    const streamSource = sseBody.__sse_responses;
    const stream = toNodeReadable(streamSource);
    const isDirectPassthrough = result.metadata?.__routecodexDirectPassthrough === true;
    const responseProjectionMetadata = {
      ...(result.metadata ?? {}),
      requestId: requestLabel
    } as Record<string, unknown>;
    const clientConnectionState =
      responseProjectionMetadata.clientConnectionState
      && typeof responseProjectionMetadata.clientConnectionState === 'object'
      && !Array.isArray(responseProjectionMetadata.clientConnectionState)
        ? responseProjectionMetadata.clientConnectionState as { disconnected?: unknown }
        : undefined;
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
    const restoredStream = isDirectPassthrough
      ? createDirectPassthroughSseGuardStream(stream, requestLabel)
      : createClientVisibleSseProjectionStream(stream, requestLabel);
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
    logPipelineStage('response.sse.prestart.inspect', requestLabel, {
      status,
      entryEndpoint,
      hasStreamSource: streamSource !== undefined,
      streamSourceType:
        streamSource === null
          ? 'null'
          : Array.isArray(streamSource)
            ? 'array'
            : typeof streamSource,
      directPassthrough: isDirectPassthrough,
      resDestroyed: res.destroyed === true,
      resWritableEnded: (res as unknown as { writableEnded?: boolean }).writableEnded === true,
      resWritableFinished: (res as unknown as { writableFinished?: boolean }).writableFinished === true,
      clientConnectionDisconnected: clientConnectionState?.disconnected === true,
    });
    const preStartClientClosed =
      res.destroyed
      || (res as unknown as { writableEnded?: boolean }).writableEnded === true
      || (res as unknown as { writableFinished?: boolean }).writableFinished === true;
    if (preStartClientClosed) {
      const details = {
        status,
        trigger: 'close',
        streamEnded: false,
        sawTerminalEvent: false,
        finishReason:
          typeof sseBody[STREAM_LOG_FINISH_REASON_KEY] === 'string'
            ? String(sseBody[STREAM_LOG_FINISH_REASON_KEY])
            : undefined,
        closeBeforeStreamEnd: true,
        detectedBeforeStreamStart: true
      };
      getSessionExecutionStateTracker().recordSseClientClose(requestLabel, {
        finishReason: details.finishReason,
        terminal: false,
        closeBeforeStreamEnd: true
      });
      logSseClientCloseDiagnosis(requestLabel, details);
      logPipelineStage('response.sse.client_close', requestLabel, details);
      writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, 'prestart_client_close', {
        ...details,
        hasStreamSource: streamSource !== undefined,
        streamSourceType:
          streamSource === null
            ? 'null'
            : Array.isArray(streamSource)
              ? 'array'
              : typeof streamSource,
        directPassthrough: isDirectPassthrough,
        clientConnectionDisconnected: clientConnectionState?.disconnected === true,
      });
      cleanupAbandonedResponsesConversation(requestLabel, {
        entryEndpoint,
        closeBeforeStreamEnd: true,
        timingRequestIds: result.usageLogInfo?.timingRequestIds
      });
      try {
        const abortError = createSseClientResponseClosedError();
        if (typeof (stream as Readable).once === 'function') {
          (stream as Readable).once('error', (streamError) => {
            if (!isClientDisconnectAbortError(streamError)) {
              logResponseNonBlockingError(`response.sse.client_close.prestart.destroy:${requestLabel}`, streamError);
            }
          });
        }
        if (typeof (stream as Readable).destroy === 'function') {
          (stream as Readable).destroy(abortError);
        } else {
          const cancelableStream = stream as unknown as NodeReadableStream & {
            cancel?: (reason?: unknown) => Promise<void>;
          };
          if (typeof cancelableStream.cancel === 'function') {
            void cancelableStream.cancel(abortError);
          }
        }
      } catch (error) {
        logResponseNonBlockingError(`response.sse.client_close.prestart.destroy:${requestLabel}`, error);
      }
      return Promise.resolve();
    }
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
      if (shouldDropClientSseFrame(frame, entryEndpoint)) {
        return;
      }
      if (options?.recordSnapshot !== false) {
        clientSseSnapshotRecorder?.record(frame);
      }
      logSseFrameProjection(requestLabel, 'response.sse.write_frame', frame);
      try {
        res.write(frame);
      } catch (error) {
        logResponseNonBlockingError(`${errorLabel}:${requestLabel}`, error);
      }
    };

    let ended = false;
    const completionLogState: StreamCompletionLogState = { logged: false };
    let cleanupLogged = false;
    let streamEnded = false;
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
    const responsesContinuationOwner =
      result.metadata?.__routecodexDirectPassthrough === true ? 'direct' : 'relay';
    const persistNativeSseConversationState = async (): Promise<void> => {
      if (nativeSseConversationPersisted) {
        logResponsesContinuationTrace('sse.persist.skip.already_persisted', requestLabel);
        return;
      }
      if (
        (
        (entryEndpoint !== '/v1/responses'
          && entryEndpoint !== '/v1/responses.submit_tool_outputs')
        || !contractProbe.probe
        || typeof contractProbe.probe !== 'object'
        || Array.isArray(contractProbe.probe)
        )
      ) {
        logResponsesContinuationTrace('sse.persist.skip.not_eligible', requestLabel, {
          entryEndpoint: entryEndpoint ?? 'unknown',
          hasProbe: Boolean(contractProbe.probe)
        });
        return;
      }
      nativeSseConversationPersisted = true;
      const conversationProviderKey = deriveResponsesConversationProviderKey(result.usageLogInfo);
      const sanitizedProbeBody = stripInternalKeysDeep(contractProbe.probe as Record<string, unknown>);
      logResponsesContinuationTrace('sse.persist.start', requestLabel, {
        responseId: readResponsesConversationResponseId(sanitizedProbeBody),
        finishReason: deriveFinishReason(sanitizedProbeBody) ?? finishTracker.finishReason ?? undefined,
        continuationOwner: responsesContinuationOwner,
        providerKey: conversationProviderKey,
        hasRequestContext: Boolean(effectiveResponsesRequestContext)
      });
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
        continuationOwner: responsesContinuationOwner,
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
      logResponsesContinuationTrace('sse.persist.done', requestLabel, {
        responseId: readResponsesConversationResponseId(sanitizedProbeBody),
        finishReason: deriveFinishReason(sanitizedProbeBody) ?? finishTracker.finishReason ?? undefined
      });
    };
    const resolveTerminalProbeFinishReason = (): string | undefined => {
      if (finishTracker.finishReason && finishTracker.finishReason.trim()) {
        return finishTracker.finishReason.trim();
      }
      if (!contractProbe.probe || typeof contractProbe.probe !== 'object' || Array.isArray(contractProbe.probe)) {
        return undefined;
      }
      const sanitizedProbeBody = stripInternalKeysDeep(contractProbe.probe as Record<string, unknown>);
      const derived = deriveFinishReason(sanitizedProbeBody);
      if (derived && derived.trim()) {
        finishTracker.finishReason = derived.trim();
        return finishTracker.finishReason;
      }
      return undefined;
    };
    const finalizeSyntheticTerminalClose = (): void => {
      const resolvedFinishReason = resolveTerminalProbeFinishReason();
      if (resolvedFinishReason) {
        finishTracker.finishReason = resolvedFinishReason;
      }
      finishTracker.seenTerminalEvent = true;
      terminalWatch.sawTerminalChunk = true;
      streamEnded = true;
      getSessionExecutionStateTracker().recordSseStreamEnd(requestLabel, {
        finishReason: finishTracker.finishReason,
        terminal: true
      });
      logStreamRequestCompleteOnce(
        completionLogState,
        entryEndpoint,
        requestLabel,
        status,
        finishTracker.finishReason,
        requestLogContext
      );
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
    if (totalTimeoutMs === undefined) {
      totalTimeoutMs = DEFAULT_SSE_TOTAL_TIMEOUT_MS;
    }

    const keepaliveMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_KEEPALIVE_MS', 'RCC_HTTP_SSE_KEEPALIVE_MS'],
      3_000
    );
    const projectionTimeoutMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS', 'RCC_HTTP_SSE_PROJECTION_TIMEOUT_MS'],
      DEFAULT_SSE_PROJECTION_TIMEOUT_MS
    );
    const terminalCloseTimeoutMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS', 'RCC_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS'],
      DEFAULT_SSE_TERMINAL_CLOSE_TIMEOUT_MS
    );

    const detachOutboundStream = () => {
      try {
        outboundStream.unpipe(res);
      } catch (error) {
        logResponseNonBlockingError(`response.sse.unpipe:${requestLabel}`, error);
      }
    };
    const destroySourceStream = (error?: Error) => {
      try {
        if (error && isClientDisconnectAbortError(error)) {
          stream.once('error', (streamError) => {
            if (!isClientDisconnectAbortError(streamError)) {
              logResponseNonBlockingError(`response.sse.cleanup.destroy_stream:${requestLabel}`, streamError);
            }
          });
        }
        stream.destroy?.(error);
      } catch (destroyError) {
        logResponseNonBlockingError(`response.sse.cleanup.destroy_stream:${requestLabel}`, destroyError);
      }
    };
    let clientCloseAbortScheduled = false;
    const abortSourceStreamForClientClose = () => {
      if (clientCloseAbortScheduled) {
        return;
      }
      clientCloseAbortScheduled = true;
      const abortError = createSseClientResponseClosedError();
      setImmediate(() => {
        destroySourceStream(abortError);
      });
    };
    const runClientCloseBeforeTerminalCleanup = (closeBeforeStreamEnd: boolean) => {
      abortSourceStreamForClientClose();
      void (async () => {
        const hasContinuationProbe =
          (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
          && effectiveResponsesRequestContext
          && contractProbe.probe
          && typeof contractProbe.probe === 'object'
          && !Array.isArray(contractProbe.probe)
          && isToolCallContinuationResponse(contractProbe.probe);
        if (hasContinuationProbe) {
          logResponsesContinuationTrace('client_close.persist_continuation', requestLabel, {
            closeBeforeStreamEnd,
            detectedBeforeStreamStart: !streamEnded
          });
          await persistNativeSseConversationState();
          await finalizeResponsesConversationRequestRetention(requestLabel, { keepForSubmitToolOutputs: true });
          return;
        }
        logResponsesContinuationTrace('client_close.clear_abandoned', requestLabel, {
          closeBeforeStreamEnd,
          detectedBeforeStreamStart: !streamEnded
        });
        cleanupAbandonedResponsesConversation(requestLabel, {
          entryEndpoint,
          closeBeforeStreamEnd,
          timingRequestIds: result.usageLogInfo?.timingRequestIds
        });
      })().catch((error) => {
        logResponseNonBlockingError(`response.sse.client_close.cleanup:${requestLabel}`, error);
      });
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

    const endWithSseError = (code: string, message: string, statusCode = 504, logLabel = 'response.sse.stream.timeout') => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimers();
      detachOutboundStream();
      logPipelineStage(logLabel, requestLabel, { code, message });
      writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, code, {
        status: statusCode,
        message,
        lastRawFrame: lastRawClientFrameSummary ?? undefined,
        lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
        probe: contractProbe.probe ?? undefined,
        streamEnded,
        sawTerminalEvent: finishTracker.seenTerminalEvent,
        finishReason: finishTracker.finishReason,
      });
      const payload = { type: 'error', status: statusCode, error: { message, code, request_id: requestLabel } };
      writeClientSseFrame(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, 'response.sse.error.write_error_event');
      try {
        res.end();
      } catch (error) {
        logResponseNonBlockingError(`response.sse.error.end:${requestLabel}`, error);
      }
      clientSseSnapshotRecorder?.flush();
      try {
        stream.destroy?.(Object.assign(new Error(message), { code }));
      } catch (error) {
        logResponseNonBlockingError(`response.sse.error.destroy_stream:${requestLabel}`, error);
      }
    };

    if (typeof totalTimeoutMs === 'number' && Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        endWithSseError('HTTP_SSE_TIMEOUT', `SSE timeout after ${totalTimeoutMs}ms`);
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }

    // Keep-alive: send SSE comments periodically so clients don't treat long servertool holds as a dead connection.
    // Emit one frame immediately so short client read deadlines are refreshed before first upstream token arrives.
    // Responses clients may not count SSE comments as activity for idle timers, so add an explicit ping event there.
    const keepaliveFrame = buildClientSseKeepaliveFrame(entryEndpoint);
    if (!ended) {
      writeClientSseFrame(keepaliveFrame, 'response.sse.keepalive.initial_write');
    }
    if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (ended) {
          return;
        }
        writeClientSseFrame(keepaliveFrame, 'response.sse.keepalive.write');
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
      const closeBeforeStreamEnd = trigger === 'close' && !streamEnded && !finishTracker.seenTerminalEvent;
      const details = {
        status,
        trigger,
        streamEnded,
        sawTerminalEvent: finishTracker.seenTerminalEvent,
        finishReason: finishTracker.finishReason,
        lastRawFrame: lastRawClientFrameSummary ?? undefined,
        lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
        probe: contractProbe.probe ?? undefined
      };
      if (closeBeforeStreamEnd) {
        logSseClientCloseDiagnosis(requestLabel, {
          ...details,
          closeBeforeStreamEnd
        });
        logPipelineStage('response.sse.client_close', requestLabel, {
          ...details,
          closeBeforeStreamEnd
        });
        writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, 'client_close_before_terminal', {
          ...details,
          closeBeforeStreamEnd
        });
        runClientCloseBeforeTerminalCleanup(closeBeforeStreamEnd);
        return;
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
    let lastProjectedClientFrameSummary: Record<string, unknown> | null = null;
    let lastRawClientFrameSummary: Record<string, unknown> | null = null;
    const responsesSseProjectionState: ResponsesSseClientProjectionState = {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    };
    const projectClientSseFrame = (frame: string, stage: string): Promise<string> =>
      withSseClientProjectionTimeout(
        normalizeResponsesSseFrameForClient(
          frame,
          entryEndpoint,
          effectiveResponsesRequestContext,
          responseProjectionMetadata,
          responsesSseProjectionState,
          requestLabel
        ),
        projectionTimeoutMs,
        requestLabel,
        stage
      );
    const enqueueClientSseFrame = (frame: string, errorLabel: string) => {
      assertClientSseFrameHasNoInternalCarriers(frame, requestLabel);
      clientWriteQueue = clientWriteQueue
        .then(async () => projectClientSseFrame(frame, errorLabel))
        .then((normalizedFrame) => {
          if (!normalizedFrame) {
            logPipelineStage('response.sse.project_frame', requestLabel, {
              emit: false,
              raw: summarizeSseFrameForLog(frame) ?? undefined
            });
            return;
          }
          lastRawClientFrameSummary = summarizeSseFrameForLog(frame);
          lastProjectedClientFrameSummary = summarizeSseFrameForLog(normalizedFrame);
          logPipelineStage('response.sse.project_frame', requestLabel, {
            emit: true,
            raw: lastRawClientFrameSummary ?? undefined,
            projected: lastProjectedClientFrameSummary ?? undefined
          });
          writeClientSseFrame(normalizedFrame, errorLabel, { recordSnapshot: false });
        })
        .catch((error) => {
          const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
          const sourceCode = readErrorCode(error);
          if (res.destroyed || (res as unknown as { writableEnded?: boolean }).writableEnded === true) {
            logPipelineStage('response.sse.projection.cancelled_after_client_close', requestLabel, {
              reason,
              sourceCode,
              raw: summarizeSseFrameForLog(frame) ?? undefined,
            });
            return;
          }
          const isProjectionTimeout =
            sourceCode === 'SSE_CLIENT_PROJECTION_TIMEOUT'
            || reason.includes('SSE client projection timed out');
          const projectionError = Object.assign(
            new Error(`[server.response_projection] SSE client projection failed: ${reason}`),
            { code: isProjectionTimeout ? 'SSE_CLIENT_PROJECTION_TIMEOUT' : 'SSE_CLIENT_PROJECTION_FAILED' }
          );
          logPipelineStage('response.sse.projection.error', requestLabel, {
            message: projectionError.message,
            reason,
            sourceCode,
            raw: summarizeSseFrameForLog(frame) ?? undefined,
          });
          endWithSseError(
            readErrorCode(projectionError) ?? 'SSE_CLIENT_PROJECTION_FAILED',
            'SSE stream response projection failed',
            500,
            'response.sse.projection.error'
          );
        });
    };
    const hasResponsesToolCallContinuationProbe = (): boolean => {
      if (
        (
        entryEndpoint !== '/v1/responses'
        && entryEndpoint !== '/v1/responses.submit_tool_outputs'
        )
      ) {
        return false;
      }
      return Boolean(
        contractProbe.probe
        && typeof contractProbe.probe === 'object'
        && !Array.isArray(contractProbe.probe)
        && isToolCallContinuationResponse(contractProbe.probe)
      );
    };
    const hasResponsesRequiredActionContinuationProbe = (): boolean => {
      if (!hasResponsesToolCallContinuationProbe()) {
        return false;
      }
      const probe = contractProbe.probe as Record<string, unknown>;
      return Boolean(
        probe.required_action
        && typeof probe.required_action === 'object'
        && !Array.isArray(probe.required_action)
      );
    };
    const writeTerminalProbeFramesAndClose = async (stage: string): Promise<void> => {
      if (ended || streamEnded || res.writableEnded || res.destroyed) {
        return;
      }
      try {
        await clientWriteQueue;
      } catch (error) {
        logResponseNonBlockingError(`response.sse.terminal.close.flush_queue:${requestLabel}`, error);
      }
      if (ended || streamEnded || res.writableEnded || res.destroyed) {
        return;
      }
      void persistNativeSseConversationState().catch((error) => {
        logResponseNonBlockingError(`responses-conversation-native-sse-terminal:${requestLabel}`, error);
      });
      const framesToWrite = buildResponsesTerminalSseFramesFromProbe(contractProbe.probe, requestLabel);
      if (framesToWrite.length === 0) {
        if (terminalWatch.sawAssistantMessageDoneTerminal || finishTracker.seenTerminalEvent) {
          finalizeSyntheticTerminalClose();
          if (!res.writableEnded && !res.destroyed) {
            ended = true;
            clearTimers();
            detachOutboundStream();
            try {
              res.end();
            } catch (endError) {
              logResponseNonBlockingError(`${stage}.end:${requestLabel}`, endError);
            }
            clientSseSnapshotRecorder?.flush();
            destroySourceStream();
          }
          return;
        }
        endWithSseError(
          'SSE_TERMINAL_PROBE_EMPTY',
          'SSE terminal state reached but Responses terminal frames were unavailable',
          500,
          'response.sse.terminal.close.error'
        );
        return;
      }
      try {
        for (const frame of framesToWrite) {
          const normalizedFrame = await projectClientSseFrame(frame, `${stage}.write_terminal`);
          if (normalizedFrame) {
            logPipelineStage('response.sse.terminal.write_frame', requestLabel, {
              stage,
              raw: summarizeSseFrameForLog(frame) ?? undefined,
              projected: summarizeSseFrameForLog(normalizedFrame) ?? undefined
            });
            writeClientSseFrame(normalizedFrame, `${stage}.write_terminal`);
          }
        }
        finishTracker.seenTerminalEvent = true;
        terminalWatch.sawTerminalChunk = true;
        terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || framesToWrite.some((frame) => frame.includes('event: response.completed'));
        terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || framesToWrite.some((frame) => frame.includes('event: response.done'));
        terminalWatch.terminalSource = terminalWatch.terminalSource ?? stage;
        contractProbe.emitted = true;
      } catch (repairWriteError) {
        const code = readErrorCode(repairWriteError) ?? 'SSE_CLIENT_PROJECTION_FAILED';
        const message = repairWriteError instanceof Error ? repairWriteError.message : String(repairWriteError ?? 'SSE client projection failed');
        endWithSseError(code, message, 500, 'response.sse.projection.error');
        return;
      }
      if (!res.writableEnded && !res.destroyed) {
        finalizeSyntheticTerminalClose();
        ended = true;
        clearTimers();
        detachOutboundStream();
        try {
          res.end();
        } catch (endError) {
          logResponseNonBlockingError(`${stage}.end:${requestLabel}`, endError);
        }
        clientSseSnapshotRecorder?.flush();
        destroySourceStream();
      }
    };
    const scheduleTerminalProbeClose = (stage: string, delayMs: number): void => {
      if (terminalAutoCloseTimer || ended || streamEnded || res.writableEnded || res.destroyed) {
        return;
      }
      terminalAutoCloseTimer = setTimeout(() => {
        terminalAutoCloseTimer = null;
        void writeTerminalProbeFramesAndClose(stage).catch((error) => {
          logResponseNonBlockingError(`${stage}:${requestLabel}`, error);
        });
      }, delayMs);
      terminalAutoCloseTimer.unref?.();
    };
    if (hasResponsesRequiredActionContinuationProbe()) {
      scheduleTerminalProbeClose('response.sse.terminal.probe_close', terminalCloseTimeoutMs);
    }
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
        if (hasResponsesRequiredActionContinuationProbe()) {
          void persistNativeSseConversationState().catch((error) => {
            logResponseNonBlockingError(`responses-conversation-native-sse-required-action:${requestLabel}`, error);
          });
        }
        enqueueClientSseFrame(frame, 'response.sse.stream.write_frame');
      }
      if (hasResponsesRequiredActionContinuationProbe()) {
        scheduleTerminalProbeClose('response.sse.terminal.probe_close', terminalCloseTimeoutMs);
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
        scheduleTerminalProbeClose('response.sse.terminal.auto_close', 120);
      }, 25);
      terminalFlushTimer.unref?.();
    });
    outboundStream.on('error', (error: Error) => {
      if (isClientDisconnectAbortError(error)) {
        logPipelineStage('response.sse.stream.client_abort', requestLabel, { message: error.message });
        return;
      }
      if (ended) {
        logPipelineStage('response.sse.stream.error_after_end', requestLabel, { message: error.message });
        return;
      }
      ended = true;
      clearTimers();
      detachOutboundStream();
      getSessionExecutionStateTracker().recordSseClientClose(requestLabel, {
        finishReason: finishTracker.finishReason,
        terminal: finishTracker.seenTerminalEvent,
        closeBeforeStreamEnd: !streamEnded
      });
      logPipelineStage('response.sse.stream.error', requestLabel, { message: error.message });
      writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, 'stream_error', {
        status: 500,
        message: error.message,
        code: readErrorCode(error),
        lastRawFrame: lastRawClientFrameSummary ?? undefined,
        lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
        probe: contractProbe.probe ?? undefined,
        streamEnded,
        sawTerminalEvent: finishTracker.seenTerminalEvent,
        finishReason: finishTracker.finishReason,
      });
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
        const clientVisibleCode = readErrorCode(error) ?? 'sse_stream_error';
        const payload = {
          type: 'error',
          status: 500,
          error: {
            message: clientVisibleMessage,
            code: clientVisibleCode,
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
      const repairedTerminalFrames =
        !terminalWatch.sawResponsesCompletedChunk
        || !terminalWatch.sawResponsesDoneEvent
        ? buildResponsesTerminalSseFramesFromProbe(contractProbe.probe, requestLabel)
        : [];
      if (repairedTerminalFrames.length > 0 && !res.writableEnded && !res.destroyed) {
        try {
          const framesToWrite = repairedTerminalFrames;
          for (const frame of framesToWrite) {
            const normalizedFrame = await projectClientSseFrame(frame, 'response.sse.stream.end.write_terminal_probe');
            if (normalizedFrame) {
              logPipelineStage('response.sse.terminal.write_frame', requestLabel, {
                stage: 'response.sse.stream.end.write_terminal_probe',
                raw: summarizeSseFrameForLog(frame) ?? undefined,
                projected: summarizeSseFrameForLog(normalizedFrame) ?? undefined
              });
              writeClientSseFrame(normalizedFrame, 'response.sse.stream.end.write_terminal_probe');
            }
          }
          if (framesToWrite.length > 0) {
            finishTracker.seenTerminalEvent = true;
            terminalWatch.sawTerminalChunk = true;
            terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || framesToWrite.some((frame) => frame.includes('event: response.completed'));
            terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || framesToWrite.some((frame) => frame.includes('event: response.done'));
            contractProbe.emitted = true;
          }
        } catch (repairWriteError) {
          const code = readErrorCode(repairWriteError) ?? 'SSE_CLIENT_PROJECTION_FAILED';
          const message = repairWriteError instanceof Error ? repairWriteError.message : String(repairWriteError ?? 'SSE client projection failed');
          endWithSseError(code, message, 500, 'response.sse.projection.error');
        }
      }
      void persistNativeSseConversationState()
        .catch((error) => {
          logResponseNonBlockingError(`responses-conversation-native-sse:${requestLabel}`, error);
        })
        .finally(async () => {
          const closedBeforeTerminalEvent = !finishTracker.seenTerminalEvent;
          if (closedBeforeTerminalEvent) {
            logPipelineStage('response.sse.stream.error', requestLabel, {
              message: 'stream closed before response.completed',
              code: 'upstream_stream_incomplete'
            });
            writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, 'upstream_stream_incomplete', {
              status: 502,
              message: 'stream closed before response.completed',
              code: 'upstream_stream_incomplete',
              lastRawFrame: lastRawClientFrameSummary ?? undefined,
              lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
              probe: contractProbe.probe ?? undefined,
              sawTerminalEvent: finishTracker.seenTerminalEvent,
              sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
              sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
              finishReason: resolvedStreamFinishReason,
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
          } else {
            logStreamRequestCompleteOnce(
              completionLogState,
              entryEndpoint,
              requestLabel,
              status,
              resolvedStreamFinishReason,
              requestLogContext
            );
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
      ?? options?.responsesRequestContext,
    result.metadata
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
  const responsesContinuationOwner =
    result.metadata?.__routecodexDirectPassthrough === true ? 'direct' : 'relay';
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
    continuationOwner: responsesContinuationOwner,
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
