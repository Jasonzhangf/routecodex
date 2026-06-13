
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
// feature_id: server.responses_response_handler_bridge_surface
import {
  assertDirectPassthroughResponsesSseFrameForHttp,
  buildClientSseKeepaliveFrameForHttp,
  buildResponsesMissingSseBridgeErrorPayloadForHttp,
  buildResponsesSseErrorPayloadForHttp,
  buildResponsesStreamIncompleteErrorPayloadForHttp,
  buildResponsesStructuredSseErrorPayloadForHttp,
  buildResponsesTerminalSseFramesFromProbeForHttp,
  createResponsesJsonToSseConverterForHttp,
  clearResponsesConversationRequestIdsForHttp,
  finalizeResponsesConversationRequestRetentionForHttp,
  importResponsesHandlerCoreDist,
  isDirectPassthroughTransportKeepaliveFrameForHttp,
  inspectResponsesTerminalStateFromSseChunkForHttp,
  normalizeResponsesSseFrameForClientForHttp,
  planResponsesStreamEndRepairForHttp,
  persistResponsesConversationLifecycleForHttp,
  planResponsesContinuationCloseActionForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  prepareResponsesJsonSseDispatchPlanForHttp,
  prepareResponsesJsonBodyForSseBridgeForHttp,
  resolveResponsesClientPayloadFinishReasonForHttp,
  resolveResponsesConversationClearReasonForHttp,
  resolveResponsesTerminalProbeFinishReasonForHttp,
  resolveResponsesProviderProtocolHintFromSseFrameForHttp,
  shouldClearResponsesConversationOnClientCloseForHttp,
  shouldClearResponsesConversationOnFailureForHttp,
  shouldPersistResponsesContinuationOnProbeUpdateForHttp,
  shouldPersistResponsesConversationStateForHttp,
  shouldRequireResponsesTerminalEventForHttp,
  summarizeResponsesSseFrameForLogForHttp,
  shouldDropClientSseFrameForHttp,
  updateResponsesContractProbeFromSseChunkForHttp
} from '../../modules/llmswitch/bridge/responses-response-bridge.js';

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
  contractProbe.probe = updateResponsesContractProbeFromSseChunkForHttp(chunk, contractProbe.probe);
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

function assertDirectPassthroughSseFrameHasNoInternalMetadataControls(frame: string, requestId: string): void {
  assertDirectPassthroughResponsesSseFrameForHttp(frame, requestId);
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

function logSseFrameProjection(
  requestLabel: string,
  stage: string,
  frame: string
): void {
  const summary = summarizeResponsesSseFrameForLogForHttp(frame);
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
  const finishReasonLabel = finishReason ? `, finish_reason=${finishReason}` : '';
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
    providerProtocol: resolveResponsesProviderProtocolHintFromSseFrameForHttp(frame)
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
      if (isDirectPassthroughTransportKeepaliveFrameForHttp(frame)) {
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
          if (isDirectPassthroughTransportKeepaliveFrameForHttp(pending)) {
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


function sendSseBridgeError(res: Response, requestLabel: string, status = 502): void {
  const payload = buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel, status);
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
  return buildResponsesStructuredSseErrorPayloadForHttp({
    body,
    requestLabel,
    status,
  });
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

async function normalizeResponsesSseFrameForClient(
  frame: string,
  entryEndpoint?: string,
  requestContext?: DispatchOptions['responsesRequestContext'],
  metadata?: Record<string, unknown>,
  projectionState?: ResponsesSseClientProjectionState,
  requestLabel = 'unknown'
): Promise<string> {
  return await normalizeResponsesSseFrameForClientForHttp({
    frame,
    entryEndpoint,
    requestContext,
    metadata,
    projectionState,
    requestLabel,
  });
}

type ResponsesJsonSseDispatchArgs = {
  res: Response;
  requestLabel: string;
  result: PipelineExecutionResult;
  status: number;
  entryEndpoint?: string;
  responsesRequestContext?: DispatchOptions['responsesRequestContext'];
  logResponseCompleted: (details?: Record<string, unknown>) => void;
};

async function streamResponsesJsonAsSse(args: ResponsesJsonSseDispatchArgs & {
  responsesPayload: Record<string, unknown>;
}): Promise<boolean> {
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
  try {
    const converter = await createResponsesJsonToSseConverterForHttp();
    const bridgePlan = await prepareResponsesJsonSseDispatchPlanForHttp({
      responsesPayload: args.responsesPayload,
      entryEndpoint: args.entryEndpoint,
      requestLabel: args.requestLabel,
      metadata:
        args.result.metadata && typeof args.result.metadata === 'object' && !Array.isArray(args.result.metadata)
          ? args.result.metadata as Record<string, unknown>
          : undefined,
      requestContext:
        args.result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined
          ?? args.responsesRequestContext,
      hasSsePayload,
    });
    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: args.entryEndpoint,
      requestLabel: args.requestLabel,
      usageLogInfo: args.result.usageLogInfo,
      metadata:
        args.result.metadata && typeof args.result.metadata === 'object' && !Array.isArray(args.result.metadata)
          ? args.result.metadata as Record<string, unknown>
          : undefined,
      requestContext:
        (args.result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined)
        ?? args.responsesRequestContext,
      body: bridgePlan.sanitizedPayload,
      onTrace: (stage, details) => logResponsesContinuationTrace(`json-to-sse.persist.${stage}`, args.requestLabel, details),
      onNonBlockingError: logResponseNonBlockingError,
    });
    const sse = await converter.convertResponseToJsonToSse(bridgePlan.normalizedPayload, {
      requestId: args.requestLabel
    });
    const stream = toNodeReadable(sse);
    if (!stream) {
      sendSseBridgeError(args.res, args.requestLabel, 502);
      return true;
    }
    stream.on('end', () => {
      if (!args.res.writableEnded && !args.res.destroyed) {
        args.res.end();
      }
      args.logResponseCompleted({
        status: args.status,
        mode: 'sse',
        finishReason: bridgePlan.finishReason
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
  return true;
}

async function dispatchResponsesJsonAsSse(args: ResponsesJsonSseDispatchArgs): Promise<boolean> {
  const responsesPayload = await prepareResponsesJsonBodyForSseBridgeForHttp({
    body: args.result.body,
    entryEndpoint: args.entryEndpoint,
    requestLabel: args.requestLabel,
    hasSsePayload,
  });
  if (!responsesPayload) {
    return false;
  }
  return streamResponsesJsonAsSse({
    ...args,
    responsesPayload,
  });
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
    const missingSsePayload = buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel, 502);
    if (await dispatchResponsesJsonAsSse({
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
          payload: structuredErrorPayload ?? missingSsePayload
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
      const missingSsePayload = buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel, 502);
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
            payload: missingSsePayload
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
      if (shouldClearResponsesConversationOnClientCloseForHttp({
        entryEndpoint,
        closeBeforeStreamEnd: true,
      })) {
        void clearResponsesConversationRequestIdsForHttp({
          requestLabel,
          timingRequestIds: result.usageLogInfo?.timingRequestIds,
          reason: 'client-close',
          onNonBlockingError: logResponseNonBlockingError,
        });
      }
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
      if (shouldDropClientSseFrameForHttp(frame, entryEndpoint)) {
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
    terminalWatch.requiresResponsesTerminalEvent = shouldRequireResponsesTerminalEventForHttp({
      entryEndpoint,
      probe: contractProbe.probe,
    });
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
      if (!shouldPersistResponsesConversationStateForHttp({
        entryEndpoint,
        probe: contractProbe.probe,
      })) {
        logResponsesContinuationTrace('sse.persist.skip.not_eligible', requestLabel, {
          entryEndpoint: entryEndpoint ?? 'unknown',
          hasProbe: Boolean(contractProbe.probe)
        });
        return;
      }
      nativeSseConversationPersisted = true;
      const sanitizedProbeBody = stripInternalKeysDeep(contractProbe.probe as Record<string, unknown>);
      logResponsesContinuationTrace('sse.persist.start', requestLabel, {
        responseId: undefined,
        finishReason: deriveFinishReason(sanitizedProbeBody) ?? finishTracker.finishReason ?? undefined,
        continuationOwner: responsesContinuationOwner,
        providerKey: result.usageLogInfo?.providerKey,
        hasRequestContext: Boolean(effectiveResponsesRequestContext)
      });
      await persistResponsesConversationLifecycleForHttp({
        entryEndpoint,
        requestLabel,
        usageLogInfo: result.usageLogInfo,
        metadata:
          result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
            ? result.metadata as Record<string, unknown>
            : undefined,
        requestContext: effectiveResponsesRequestContext,
        body: sanitizedProbeBody,
        onTrace: (stage, details) => logResponsesContinuationTrace(`sse.persist.${stage}`, requestLabel, details),
        onNonBlockingError: logResponseNonBlockingError,
      });
      logResponsesContinuationTrace('sse.persist.done', requestLabel, {
        responseId: undefined,
        finishReason: deriveFinishReason(sanitizedProbeBody) ?? finishTracker.finishReason ?? undefined
      });
    };
    const finalizeSyntheticTerminalClose = (): void => {
      const resolvedFinishReason = resolveResponsesTerminalProbeFinishReasonForHttp({
        finishReason: finishTracker.finishReason,
        probe:
          contractProbe.probe && typeof contractProbe.probe === 'object' && !Array.isArray(contractProbe.probe)
            ? stripInternalKeysDeep(contractProbe.probe as Record<string, unknown>)
            : contractProbe.probe,
      });
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
        const closeAction = planResponsesContinuationCloseActionForHttp({
          entryEndpoint,
          requestContextPresent: Boolean(effectiveResponsesRequestContext),
          probe: contractProbe.probe,
        });
        if (closeAction.action === 'persist_continuation') {
          logResponsesContinuationTrace('client_close.persist_continuation', requestLabel, {
            closeBeforeStreamEnd,
            detectedBeforeStreamStart: !streamEnded
          });
          await persistNativeSseConversationState();
          await finalizeResponsesConversationRequestRetentionForHttp(requestLabel, {
            keepForSubmitToolOutputs: closeAction.keepForSubmitToolOutputs
          });
          return;
        }
        logResponsesContinuationTrace('client_close.clear_abandoned', requestLabel, {
          closeBeforeStreamEnd,
          detectedBeforeStreamStart: !streamEnded
        });
        if (shouldClearResponsesConversationOnClientCloseForHttp({ entryEndpoint, closeBeforeStreamEnd })) {
          void clearResponsesConversationRequestIdsForHttp({
            requestLabel,
            timingRequestIds: result.usageLogInfo?.timingRequestIds,
            reason: 'client-close',
            onNonBlockingError: logResponseNonBlockingError,
          });
        }
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
      const payload = buildResponsesSseErrorPayloadForHttp({
        requestLabel,
        status: statusCode,
        message,
        code,
      });
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
    const keepaliveFrame = buildClientSseKeepaliveFrameForHttp(entryEndpoint);
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
              raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined
            });
            return;
          }
          lastRawClientFrameSummary = summarizeResponsesSseFrameForLogForHttp(frame);
          lastProjectedClientFrameSummary = summarizeResponsesSseFrameForLogForHttp(normalizedFrame);
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
              raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined,
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
            raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined,
          });
          endWithSseError(
            readErrorCode(projectionError) ?? 'SSE_CLIENT_PROJECTION_FAILED',
            'SSE stream response projection failed',
            500,
            'response.sse.projection.error'
          );
        });
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
      const framesToWrite = buildResponsesTerminalSseFramesFromProbeForHttp(contractProbe.probe, requestLabel);
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
              raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined,
              projected: summarizeResponsesSseFrameForLogForHttp(normalizedFrame) ?? undefined
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
        const nextTerminalState = inspectResponsesTerminalStateFromSseChunkForHttp({
          chunk: part,
          finishReason: finishTracker.finishReason,
          seenTerminalEvent: finishTracker.seenTerminalEvent,
          sawTerminalChunk: terminalWatch.sawTerminalChunk,
          sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk,
          sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent,
          sawAssistantMessageDoneTerminal: terminalWatch.sawAssistantMessageDoneTerminal,
          requiresResponsesTerminalEvent: terminalWatch.requiresResponsesTerminalEvent,
          terminalSource: terminalWatch.terminalSource,
          pendingTerminalEvent: terminalWatch.pendingTerminalEvent,
        });
        finishTracker.finishReason = nextTerminalState.finishReason;
        finishTracker.seenTerminalEvent = nextTerminalState.seenTerminalEvent;
        terminalWatch.sawTerminalChunk = nextTerminalState.sawTerminalChunk;
        terminalWatch.sawResponsesCompletedChunk = nextTerminalState.sawResponsesCompletedChunk;
        terminalWatch.sawResponsesDoneEvent = nextTerminalState.sawResponsesDoneEvent;
        terminalWatch.sawAssistantMessageDoneTerminal = nextTerminalState.sawAssistantMessageDoneTerminal;
        terminalWatch.requiresResponsesTerminalEvent = nextTerminalState.requiresResponsesTerminalEvent;
        terminalWatch.terminalSource = nextTerminalState.terminalSource;
        terminalWatch.pendingTerminalEvent = nextTerminalState.pendingTerminalEvent;
        updateContractProbeFromSseChunk(part, contractProbe);
        if (shouldPersistResponsesContinuationOnProbeUpdateForHttp({
          entryEndpoint,
          probe: contractProbe.probe,
        })) {
          void persistNativeSseConversationState().catch((error) => {
            logResponseNonBlockingError(`responses-conversation-native-sse-required-action:${requestLabel}`, error);
          });
        }
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
      if (shouldClearResponsesConversationOnFailureForHttp({
        entryEndpoint,
        status: 500,
        phase: 'sse_stream_error',
      })) {
        void clearResponsesConversationRequestIdsForHttp({
          requestLabel,
          timingRequestIds: result.usageLogInfo?.timingRequestIds,
          reason: resolveResponsesConversationClearReasonForHttp('sse_stream_error'),
          onNonBlockingError: logResponseNonBlockingError,
        });
      }
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
        const payload = buildResponsesSseErrorPayloadForHttp({
          requestLabel,
          status: 500,
          message: clientVisibleMessage,
          code: clientVisibleCode,
        });
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
        const nextTerminalState = inspectResponsesTerminalStateFromSseChunkForHttp({
          chunk: ssePending,
          finishReason: finishTracker.finishReason,
          seenTerminalEvent: finishTracker.seenTerminalEvent,
          sawTerminalChunk: terminalWatch.sawTerminalChunk,
          sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk,
          sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent,
          sawAssistantMessageDoneTerminal: terminalWatch.sawAssistantMessageDoneTerminal,
          requiresResponsesTerminalEvent: terminalWatch.requiresResponsesTerminalEvent,
          terminalSource: terminalWatch.terminalSource,
          pendingTerminalEvent: terminalWatch.pendingTerminalEvent,
        });
        finishTracker.finishReason = nextTerminalState.finishReason;
        finishTracker.seenTerminalEvent = nextTerminalState.seenTerminalEvent;
        terminalWatch.sawTerminalChunk = nextTerminalState.sawTerminalChunk;
        terminalWatch.sawResponsesCompletedChunk = nextTerminalState.sawResponsesCompletedChunk;
        terminalWatch.sawResponsesDoneEvent = nextTerminalState.sawResponsesDoneEvent;
        terminalWatch.sawAssistantMessageDoneTerminal = nextTerminalState.sawAssistantMessageDoneTerminal;
        terminalWatch.requiresResponsesTerminalEvent = nextTerminalState.requiresResponsesTerminalEvent;
        terminalWatch.terminalSource = nextTerminalState.terminalSource;
        terminalWatch.pendingTerminalEvent = nextTerminalState.pendingTerminalEvent;
        updateContractProbeFromSseChunk(ssePending, contractProbe);
        enqueueClientSseFrame(pendingFrame, 'response.sse.stream.write_pending_frame');
        ssePending = '';
      }
      try {
        await clientWriteQueue;
      } catch (error) {
        logResponseNonBlockingError(`response.sse.stream.end.flush_queue:${requestLabel}`, error);
      }
      const streamEndRepairPlan = planResponsesStreamEndRepairForHttp({
        entryEndpoint,
        probe: contractProbe.probe,
        sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
        sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
        sawTerminalEvent: finishTracker.seenTerminalEvent === true,
      });
      const repairedTerminalFrames = streamEndRepairPlan.shouldRepairTerminalFrames
        ? buildResponsesTerminalSseFramesFromProbeForHttp(contractProbe.probe, requestLabel)
        : [];
      if (repairedTerminalFrames.length > 0 && !res.writableEnded && !res.destroyed) {
        try {
          const framesToWrite = repairedTerminalFrames;
          for (const frame of framesToWrite) {
            const normalizedFrame = await projectClientSseFrame(frame, 'response.sse.stream.end.write_terminal_probe');
            if (normalizedFrame) {
              logPipelineStage('response.sse.terminal.write_frame', requestLabel, {
                stage: 'response.sse.stream.end.write_terminal_probe',
                raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined,
                projected: summarizeResponsesSseFrameForLogForHttp(normalizedFrame) ?? undefined
              });
              writeClientSseFrame(normalizedFrame, 'response.sse.stream.end.write_terminal_probe');
            }
          }
          if (framesToWrite.length > 0) {
            finishTracker.seenTerminalEvent = true;
            terminalWatch.sawTerminalChunk = true;
            terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || framesToWrite.some((frame: string) => frame.includes('event: response.completed'));
            terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || framesToWrite.some((frame: string) => frame.includes('event: response.done'));
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
          const closedBeforeTerminalRepairPlan = planResponsesStreamEndRepairForHttp({
            entryEndpoint,
            probe: contractProbe.probe,
            sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
            sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
            sawTerminalEvent: finishTracker.seenTerminalEvent === true,
          });
          if (closedBeforeTerminalEvent && closedBeforeTerminalRepairPlan.shouldRepairContinuationTerminal) {
            const repairedToolContinuationFrames = buildResponsesTerminalSseFramesFromProbeForHttp(
              contractProbe.probe,
              requestLabel
            );
            if (repairedToolContinuationFrames.length > 0 && !res.writableEnded && !res.destroyed) {
              try {
                await clientWriteQueue;
                for (const frame of repairedToolContinuationFrames) {
                  const normalizedFrame = await projectClientSseFrame(
                    frame,
                    'response.sse.stream.end.write_tool_continuation_terminal_probe'
                  );
                  if (normalizedFrame) {
                    logPipelineStage('response.sse.terminal.write_frame', requestLabel, {
                      stage: 'response.sse.stream.end.write_tool_continuation_terminal_probe',
                      raw: summarizeResponsesSseFrameForLogForHttp(frame) ?? undefined,
                      projected: summarizeResponsesSseFrameForLogForHttp(normalizedFrame) ?? undefined
                    });
                    writeClientSseFrame(
                      normalizedFrame,
                      'response.sse.stream.end.write_tool_continuation_terminal_probe'
                    );
                  }
                }
                finishTracker.seenTerminalEvent = true;
                terminalWatch.sawTerminalChunk = true;
                terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || repairedToolContinuationFrames.some((frame: string) => frame.includes('event: response.completed'));
                terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || repairedToolContinuationFrames.some((frame: string) => frame.includes('event: response.done'));
                contractProbe.emitted = true;
              } catch (repairWriteError) {
                logResponseNonBlockingError(
                  `response.sse.stream.end.write_tool_continuation_terminal_probe:${requestLabel}`,
                  repairWriteError
                );
              }
            }
          }
          const repairedClosedBeforeTerminalEvent = !finishTracker.seenTerminalEvent;
          const finalStreamEndRepairPlan = planResponsesStreamEndRepairForHttp({
            entryEndpoint,
            probe: contractProbe.probe,
            sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
            sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
            sawTerminalEvent: finishTracker.seenTerminalEvent === true,
          });
          if (repairedClosedBeforeTerminalEvent && finalStreamEndRepairPlan.shouldProjectIncompleteError) {
            const incompletePayload = buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel);
            const incompleteError =
              incompletePayload.error && typeof incompletePayload.error === 'object' && !Array.isArray(incompletePayload.error)
                ? incompletePayload.error as Record<string, unknown>
                : {};
            const incompleteMessage =
              typeof incompleteError.message === 'string' ? incompleteError.message : 'Upstream provider error';
            const incompleteCode =
              typeof incompleteError.code === 'string' ? incompleteError.code : 'HTTP_HANDLER_ERROR';
            logPipelineStage('response.sse.stream.error', requestLabel, {
              message: incompleteMessage,
              code: incompleteCode
            });
            writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, incompleteCode, {
              status: 502,
              message: incompleteMessage,
              code: incompleteCode,
              lastRawFrame: lastRawClientFrameSummary ?? undefined,
              lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
              probe: contractProbe.probe ?? undefined,
              sawTerminalEvent: finishTracker.seenTerminalEvent,
              sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
              sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
              finishReason: resolvedStreamFinishReason,
            });
            if (shouldClearResponsesConversationOnFailureForHttp({
              entryEndpoint,
              status: 502,
              phase: 'sse_incomplete',
            })) {
              void clearResponsesConversationRequestIdsForHttp({
                requestLabel,
                timingRequestIds: result.usageLogInfo?.timingRequestIds,
                reason: resolveResponsesConversationClearReasonForHttp('sse_incomplete'),
                onNonBlockingError: logResponseNonBlockingError,
              });
            }
            if (!res.writableEnded && !res.destroyed) {
              try {
                await clientWriteQueue;
                writeClientSseFrame(`event: error\ndata: ${JSON.stringify(incompletePayload)}\n\n`, 'response.sse.stream.end.write_error_event');
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
    if (shouldClearResponsesConversationOnFailureForHttp({
      entryEndpoint,
      status,
      phase: 'json_empty',
    })) {
      await clearResponsesConversationRequestIdsForHttp({
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        reason: resolveResponsesConversationClearReasonForHttp('json_empty'),
        onNonBlockingError: logResponseNonBlockingError,
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
  const jsonDispatchPlan = await prepareResponsesJsonClientDispatchPlanForHttp({
    body,
    entryEndpoint,
    requestLabel,
    requestContext:
      result.metadata?.responsesRequestContext as DispatchOptions['responsesRequestContext'] | undefined
        ?? options?.responsesRequestContext,
    metadata:
      result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
        ? result.metadata as Record<string, unknown>
        : undefined,
    hasSsePayload,
    resolveBridge: importResponsesHandlerCoreDist,
  });
  const usageNormalized = normalizeChatUsagePayload(jsonDispatchPlan.clientBody, {
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
  const sanitized = usageNormalized.normalized
    ? stripInternalKeysDeep(clientBody)
    : jsonDispatchPlan.sanitizedBody;
  if (shouldClearResponsesConversationOnFailureForHttp({
    entryEndpoint,
    status,
    phase: 'json',
  })) {
    await clearResponsesConversationRequestIdsForHttp({
      requestLabel,
      timingRequestIds: result.usageLogInfo?.timingRequestIds,
      responseId: undefined,
      reason: resolveResponsesConversationClearReasonForHttp('json'),
      onNonBlockingError: logResponseNonBlockingError,
    });
  }
  const jsonFinishReason = usageNormalized.normalized
    ? resolveResponsesClientPayloadFinishReasonForHttp(clientBody)
    : jsonDispatchPlan.finishReason;
  await persistResponsesConversationLifecycleForHttp({
    entryEndpoint,
    requestLabel,
    usageLogInfo: result.usageLogInfo,
    metadata:
      result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
        ? result.metadata as Record<string, unknown>
        : undefined,
    requestContext: options?.responsesRequestContext,
    body: sanitized,
    onTrace: (stage, details) => logResponsesContinuationTrace(`json.persist.${stage}`, requestLabel, details),
    onNonBlockingError: logResponseNonBlockingError,
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
