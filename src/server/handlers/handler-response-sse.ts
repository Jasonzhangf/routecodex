import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import {
  applyHeaders,
  assertClientResponseHasNoInternalCarriers,
  createClientSseSnapshotRecorder,
  logResponseNonBlockingError,
  maybeAttachClientSseSnapshotStream,
  releaseMetadataCenterForHttpResponse,
  shouldCaptureClientResponseSnapshotStage,
  toNodeReadable,
  type ClientSseSnapshotRecorder,
  type DispatchOptions,
  type ResponsesRequestContext,
} from './handler-response-common.js';
import { formatRequestTimingSummary, logPipelineStage } from '../utils/stage-logger.js';
import { extractUsageFromResult } from '../runtime/http-server/executor/usage-aggregator.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { deriveFinishReason } from '../utils/finish-reason.js';
import {
  colorizeRequestLog,
} from '../utils/request-log-color.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';
import { isClientDisconnectAbortError } from '../runtime/http-server/executor-provider.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp,
  assertDirectPassthroughResponsesSseFrameForHttp,
  buildClientSseKeepaliveFrameForHttp,
  buildResponsesMissingSseBridgeErrorPayloadForHttp,
  buildResponsesSseErrorPayloadForHttp,
  buildResponsesStreamIncompleteErrorPayloadForHttp,
  buildResponsesStructuredSseErrorPayloadForHttp,
  createChatJsonToSseConverterForHttp,
  buildResponsesTerminalSseFramesFromProbeForHttp,
  createResponsesJsonToSseConverterForHttp,
  isDirectPassthroughTransportKeepaliveFrameForHttp,
  inspectResponsesTerminalStateFromSseChunkForHttp,
  normalizeResponsesSseFrameForClientForHttp,
  planResponsesContinuationCloseActionForHttp,
  planResponsesStreamEndRepairForHttp,
  prepareResponsesJsonBodyForSseBridgeForHttp,
  prepareResponsesJsonSseDispatchPlanForHttp,
  resolveResponsesRequestContextForHttp,
  resolveResponsesProviderProtocolHintFromSseFrameForHttp,
  resolveResponsesTerminalProbeFinishReasonForHttp,
  shouldDropClientSseFrameForHttp,
  shouldPersistResponsesContinuationOnProbeUpdateForHttp,
  shouldPersistResponsesConversationStateForHttp,
  shouldRequireResponsesTerminalEventForHttp,
  summarizeResponsesSseFrameForLogForHttp,
  updateResponsesContractProbeFromSseChunkForHttp
} from '../../modules/llmswitch/bridge/responses-sse-bridge.js';
import {
  clearResponsesConversationRequestIdsForHttp,
  finalizeResponsesConversationRequestRetentionForHttp,
  persistResponsesConversationLifecycleForHttp,
  resolveResponsesConversationClearReasonForHttp,
  shouldClearResponsesConversationOnClientCloseForHttp,
  shouldClearResponsesConversationOnFailureForHttp,
} from '../../modules/llmswitch/bridge/responses-response-bridge.js';

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

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

type ResponsesSseClientProjectionState = {
  pendingApplyPatchArgumentDeltas: Record<string, string>;
  applyPatchCallIds: string[];
  emittedApplyPatchDoneCallIds: string[];
};

function summarizeResponsesProbeForLog(
  probe: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!probe) {
    return undefined;
  }
  const output = Array.isArray(probe.output) ? probe.output : [];
  const outputTypes = output
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return undefined;
      }
      const row = item as Record<string, unknown>;
      return typeof row.type === 'string' && row.type.trim() ? row.type.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const statuses = output
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return undefined;
      }
      const row = item as Record<string, unknown>;
      return typeof row.status === 'string' && row.status.trim() ? row.status.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const requiredAction =
    probe.required_action && typeof probe.required_action === 'object' && !Array.isArray(probe.required_action)
      ? probe.required_action as Record<string, unknown>
      : undefined;
  const submitToolOutputs =
    requiredAction?.submit_tool_outputs && typeof requiredAction.submit_tool_outputs === 'object' && !Array.isArray(requiredAction.submit_tool_outputs)
      ? requiredAction.submit_tool_outputs as Record<string, unknown>
      : undefined;
  const requiredToolCalls = Array.isArray(submitToolOutputs?.tool_calls) ? submitToolOutputs.tool_calls.length : 0;
  return {
    id: typeof probe.id === 'string' ? probe.id : undefined,
    status: typeof probe.status === 'string' ? probe.status : undefined,
    outputCount: output.length,
    outputTypes: outputTypes.length > 0 ? outputTypes : undefined,
    outputStatuses: statuses.length > 0 ? statuses : undefined,
    hasRequiredAction: Boolean(requiredAction),
    requiredActionType: typeof requiredAction?.type === 'string' ? requiredAction.type : undefined,
    requiredToolCallCount: requiredToolCalls > 0 ? requiredToolCalls : undefined,
    sawResponseCompleted: probe.__seen_response_completed === true,
    sawResponseDone: probe.__seen_response_done === true,
    sawResponseRequiredAction: probe.__seen_response_required_action === true,
  };
}

type SendSsePipelineResponseArgs = {
  res: Response;
  result: PipelineExecutionResult;
  requestLabel: string;
  status: number;
  body: unknown;
  forceSSE: boolean;
  expectsStream: boolean;
  entryEndpoint?: string;
  sseTotalTimeoutMs?: number;
  requestLogContext: Record<string, unknown>;
  responsesRequestContext?: ResponsesRequestContext;
  logResponseCompleted: (details?: Record<string, unknown>) => void;
};

type ResponsesJsonSseDispatchArgs = {
  res: Response;
  requestLabel: string;
  result: PipelineExecutionResult;
  status: number;
  entryEndpoint?: string;
  responsesRequestContext?: DispatchOptions['responsesRequestContext'];
  logResponseCompleted: (details?: Record<string, unknown>) => void;
};

const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';
const DEFAULT_SSE_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_SSE_PROJECTION_TIMEOUT_MS = 5_000;
const DEFAULT_SSE_TERMINAL_CLOSE_TIMEOUT_MS = 1_500;

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

function logSseClientCloseDiagnosis(requestLabel: string, details: Record<string, unknown>): void {
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

function logSseFrameProjection(requestLabel: string, stage: string, frame: string): void {
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

function createClientVisibleSseProjectionStream(stream: Readable, requestId: string): Readable {
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

function createDirectPassthroughSseGuardStream(stream: Readable, requestId: string): Readable {
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
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame, requestId);
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
          assertDirectPassthroughResponsesSseMetadataIsolationForHttp(pending, requestId);
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

function sendSseBridgeError(
  res: Response,
  requestLabel: string,
  status = 502,
  metadata?: Record<string, unknown>,
  releaseReason = 'sse_bridge_error_closeout'
): void {
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
  releaseMetadataCenterForHttpResponse(metadata, releaseReason);
}

function extractStructuredSseErrorPayload(
  body: unknown,
  requestLabel: string,
  status: number
): Record<string, unknown> | null {
  return buildResponsesStructuredSseErrorPayloadForHttp({
    body,
    requestLabel,
    status,
  });
}

function sendStructuredSseError(
  res: Response,
  requestLabel: string,
  payload: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  releaseReason = 'sse_structured_error_closeout'
): void {
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
  releaseMetadataCenterForHttpResponse(metadata, releaseReason);
}

async function normalizeResponsesSseFrameForClient(args: {
  frame: string;
  entryEndpoint?: string;
  directPassthrough?: boolean;
  requestContext?: DispatchOptions['responsesRequestContext'];
  metadata?: Record<string, unknown>;
  projectionState?: ResponsesSseClientProjectionState;
  requestLabel?: string;
}): Promise<string> {
  return await normalizeResponsesSseFrameForClientForHttp({
    frame: args.frame,
    entryEndpoint: args.entryEndpoint,
    directPassthrough: args.directPassthrough,
    requestContext: args.requestContext,
    metadata: args.metadata,
    projectionState: args.projectionState,
    requestLabel: args.requestLabel,
  });
}

function createResponsesClientProjectionStream(args: {
  stream: Readable;
  entryEndpoint?: string;
  requestContext?: DispatchOptions['responsesRequestContext'];
  metadata?: Record<string, unknown>;
  requestLabel: string;
}): Readable {
  let pending = '';
  const projectionState: ResponsesSseClientProjectionState = {
    pendingApplyPatchArgumentDeltas: {},
    applyPatchCallIds: [],
    emittedApplyPatchDoneCallIds: [],
  };
  const pushReadyFrames = async (target: Transform) => {
    let boundary = /\r?\n\r?\n/.exec(pending);
    while (boundary) {
      const frameEnd = boundary.index + boundary[0].length;
      const frame = pending.slice(0, frameEnd);
      pending = pending.slice(frameEnd);
      if (shouldDropClientSseFrameForHttp(frame, args.entryEndpoint)) {
        boundary = /\r?\n\r?\n/.exec(pending);
        continue;
      }
      const normalizedFrame = await normalizeResponsesSseFrameForClient({
        frame,
        entryEndpoint: args.entryEndpoint,
        directPassthrough: true,
        requestContext: args.requestContext,
        metadata: args.metadata,
        projectionState,
        requestLabel: args.requestLabel,
      });
      if (!normalizedFrame) {
        boundary = /\r?\n\r?\n/.exec(pending);
        continue;
      }
      assertClientSseFrameHasNoInternalCarriers(normalizedFrame, args.requestLabel);
      target.push(normalizedFrame);
      boundary = /\r?\n\r?\n/.exec(pending);
    }
  };
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      pending +=
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : String(chunk ?? '');
      void pushReadyFrames(this)
        .then(() => callback())
        .catch((error) => callback(error as Error));
    },
    flush(callback) {
      if (!pending) {
        callback();
        return;
      }
      void (async () => {
        const normalizedFrame = await normalizeResponsesSseFrameForClient({
          frame: pending,
          entryEndpoint: args.entryEndpoint,
          directPassthrough: true,
          requestContext: args.requestContext,
          metadata: args.metadata,
          projectionState,
          requestLabel: args.requestLabel,
        });
        pending = '';
        if (normalizedFrame) {
          assertClientSseFrameHasNoInternalCarriers(normalizedFrame, args.requestLabel);
          this.push(normalizedFrame);
        }
      })().then(() => callback()).catch((error) => callback(error as Error));
    }
  });
  return args.stream.pipe(transform);
}

async function streamResponsesJsonAsSse(
  args: ResponsesJsonSseDispatchArgs & { responsesPayload: Record<string, unknown> }
): Promise<boolean> {
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
    const responsesRequestContext = resolveResponsesRequestContextForHttp({
      metadata: args.result.metadata,
      fallback: args.responsesRequestContext,
    });
    const bridgePlan = await prepareResponsesJsonSseDispatchPlanForHttp({
      responsesPayload: args.responsesPayload,
      entryEndpoint: args.entryEndpoint,
      requestLabel: args.requestLabel,
      metadata:
        args.result.metadata && typeof args.result.metadata === 'object' && !Array.isArray(args.result.metadata)
          ? args.result.metadata as Record<string, unknown>
          : undefined,
      requestContext: responsesRequestContext,
    });
    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: args.entryEndpoint,
      requestLabel: args.requestLabel,
      usageLogInfo: args.result.usageLogInfo,
      metadata:
        args.result.metadata && typeof args.result.metadata === 'object' && !Array.isArray(args.result.metadata)
          ? args.result.metadata as Record<string, unknown>
          : undefined,
      requestContext: responsesRequestContext,
      body: bridgePlan.sanitizedPayload,
      onTrace: (stage, details) => logResponsesContinuationTrace(`json-to-sse.persist.${stage}`, args.requestLabel, details),
      onNonBlockingError: logResponseNonBlockingError,
    });
    const sse = await converter.convertResponseToJsonToSse(bridgePlan.normalizedPayload, {
      requestId: args.requestLabel
    });
    const rawStream = toNodeReadable(sse);
    const stream = rawStream
      ? createResponsesClientProjectionStream({
        stream: rawStream,
        entryEndpoint: args.entryEndpoint,
        requestContext: responsesRequestContext,
        metadata:
          args.result.metadata && typeof args.result.metadata === 'object' && !Array.isArray(args.result.metadata)
            ? args.result.metadata as Record<string, unknown>
            : undefined,
        requestLabel: args.requestLabel,
      })
      : null;
    if (!stream) {
      sendSseBridgeError(
        args.res,
        args.requestLabel,
        502,
        args.result.metadata as Record<string, unknown> | undefined,
        'json_to_sse_bridge_missing_stream_closeout'
      );
      return true;
    }
    stream.on('end', () => {
      if (!args.res.writableEnded && !args.res.destroyed) {
        args.res.end();
      }
      releaseMetadataCenterForHttpResponse(args.result.metadata, 'json_to_sse_closeout');
      args.logResponseCompleted({
        status: args.status,
        mode: 'sse',
        finishReason: bridgePlan.finishReason
      });
    });
    stream.on('error', (error: Error) => {
      logResponseNonBlockingError(`response.sse.json_bridge.stream:${args.requestLabel}`, error);
      if (!args.res.writableEnded && !args.res.destroyed) {
        sendSseBridgeError(
          args.res,
          args.requestLabel,
          502,
          args.result.metadata as Record<string, unknown> | undefined,
          'json_to_sse_stream_error_closeout'
        );
      }
    });
    stream.pipe(args.res, { end: false });
  } catch (error) {
    logResponseNonBlockingError(`response.sse.json_bridge:${args.requestLabel}`, error);
    if (!args.res.writableEnded && !args.res.destroyed) {
      sendSseBridgeError(
        args.res,
        args.requestLabel,
        502,
        args.result.metadata as Record<string, unknown> | undefined,
        'json_to_sse_bridge_error_closeout'
      );
    }
  }
  return true;
}

async function streamChatCompletionsJsonAsSse(
  args: ResponsesJsonSseDispatchArgs
): Promise<boolean> {
  if (
    args.entryEndpoint !== '/v1/chat/completions'
    || !args.result.body
    || typeof args.result.body !== 'object'
    || Array.isArray(args.result.body)
  ) {
    return false;
  }
  const record = args.result.body as Record<string, unknown>;
  if (record.object !== 'chat.completion') {
    return false;
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
  try {
    const converter = await createChatJsonToSseConverterForHttp();
    const sse = await converter.convertResponseToJsonToSse(args.result.body, {
      requestId: args.requestLabel,
    });
    const stream = toNodeReadable(sse);
    if (!stream) {
      sendSseBridgeError(
        args.res,
        args.requestLabel,
        502,
        args.result.metadata as Record<string, unknown> | undefined,
        'json_to_sse_bridge_missing_stream_closeout'
      );
      return true;
    }
    stream.on('end', () => {
      if (!args.res.writableEnded && !args.res.destroyed) {
        args.res.end();
      }
      releaseMetadataCenterForHttpResponse(args.result.metadata, 'json_to_sse_closeout');
      args.logResponseCompleted({
        status: args.status,
        mode: 'sse',
        finishReason: deriveFinishReason(args.result.body)
      });
    });
    stream.on('error', (error: Error) => {
      logResponseNonBlockingError(`response.sse.chat_json_bridge.stream:${args.requestLabel}`, error);
      if (!args.res.writableEnded && !args.res.destroyed) {
        sendSseBridgeError(
          args.res,
          args.requestLabel,
          502,
          args.result.metadata as Record<string, unknown> | undefined,
          'json_to_sse_stream_error_closeout'
        );
      }
    });
    stream.pipe(args.res, { end: false });
    return true;
  } catch (error) {
    logResponseNonBlockingError(`response.sse.chat_json_bridge:${args.requestLabel}`, error);
    if (!args.res.writableEnded && !args.res.destroyed) {
      sendSseBridgeError(
        args.res,
        args.requestLabel,
        502,
        args.result.metadata as Record<string, unknown> | undefined,
        'json_to_sse_bridge_error_closeout'
      );
    }
    return true;
  }
}

async function dispatchResponsesJsonAsSse(args: ResponsesJsonSseDispatchArgs): Promise<boolean> {
  const responsesPayload = await prepareResponsesJsonBodyForSseBridgeForHttp({
    body: args.result.body,
    entryEndpoint: args.entryEndpoint,
    requestLabel: args.requestLabel,
  });
  if (!responsesPayload) {
    return false;
  }
  return streamResponsesJsonAsSse({
    ...args,
    responsesPayload,
  });
}

export async function sendSsePipelineResponse(args: SendSsePipelineResponseArgs): Promise<boolean | Error> {
  const { res, result, requestLabel, status, body, forceSSE, expectsStream, entryEndpoint, requestLogContext } = args;
  if (forceSSE && result.sseStream === undefined) {
    if (await streamChatCompletionsJsonAsSse({
      res,
      requestLabel,
      result,
      status,
      entryEndpoint,
      responsesRequestContext: args.responsesRequestContext,
      logResponseCompleted: args.logResponseCompleted
    })) {
      return true;
    }
    const missingSsePayload = buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel, 502);
    if (await dispatchResponsesJsonAsSse({
      res,
      requestLabel,
      result,
      status,
      entryEndpoint,
      responsesRequestContext: args.responsesRequestContext,
      logResponseCompleted: args.logResponseCompleted
    })) {
      return true;
    }
    logPipelineStage('response.sse.missing', requestLabel, { status });
    const structuredErrorPayload = extractStructuredSseErrorPayload(body, requestLabel, status);
    args.logResponseCompleted({
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
      sendStructuredSseError(
        res,
        requestLabel,
        structuredErrorPayload,
        result.metadata as Record<string, unknown> | undefined,
        'force_sse_structured_error_closeout'
      );
      return true;
    }
    sendSseBridgeError(
      res,
      requestLabel,
      502,
      result.metadata as Record<string, unknown> | undefined,
      'force_sse_missing_stream_closeout'
    );
    return true;
  }

  if (!expectsStream) {
    return false;
  }

  const streamSource = result.sseStream;
  const stream = toNodeReadable(streamSource);
  const resultMetadata =
    result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
      ? result.metadata as Record<string, unknown>
      : undefined;
  const continuationOwner = result.continuationOwner ?? 'relay';
  const isDirectPassthrough = continuationOwner === 'direct';
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
    args.logResponseCompleted({ status: 200, mode: 'sse', reason: 'missing_stream', bridgeStatus: 502 });
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
    sendSseBridgeError(
      res,
      requestLabel,
      502,
      resultMetadata,
      'missing_stream_closeout'
    );
    return true;
  }
  const restoredStream = isDirectPassthrough
    ? createDirectPassthroughSseGuardStream(stream, requestLabel)
    : createClientVisibleSseProjectionStream(stream, requestLabel);
  const clientSseSnapshotRecorder = shouldCaptureClientResponseSnapshotStage('client-response')
    ? createClientSseSnapshotRecorder(restoredStream, res, {
      requestId: requestLabel,
      entryEndpoint,
      status,
      headers: result.headers
    })
    : undefined;
  const outboundStream = shouldCaptureClientResponseSnapshotStage('client-response')
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
      finishReason: undefined,
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
    releaseMetadataCenterForHttpResponse(resultMetadata, 'sse_prestart_client_close');
    return true;
  }

  applyHeaders(res, result.headers, true);
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
    if (
      result.continuationOwner !== 'direct'
      && shouldDropClientSseFrameForHttp(frame, entryEndpoint)
    ) {
      return;
    }
    if (options?.recordSnapshot !== false) {
      clientSseSnapshotRecorder?.record(frame);
    }
    if (!isDirectPassthroughTransportKeepaliveFrameForHttp(frame)) {
      clientSemanticFrameWritten = true;
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
  let clientSemanticFrameWritten = false;
  const finishTracker: SseFinishReasonTracker = {
    finishReason: undefined,
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
    probe: undefined,
    emitted: false
  };
  terminalWatch.requiresResponsesTerminalEvent = shouldRequireResponsesTerminalEventForHttp({
    entryEndpoint,
    probe: contractProbe.probe,
  });
  const effectiveResponsesRequestContext = resolveResponsesRequestContextForHttp({
    metadata: result.metadata,
    fallback: args.responsesRequestContext,
  });
  let nativeSseConversationPersisted = false;

  const persistNativeSseConversationState = async (): Promise<void> => {
    if (isDirectPassthrough) {
      logResponsesContinuationTrace('sse.persist.skip.direct_passthrough', requestLabel);
      return;
    }
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
      continuationOwner,
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
      continuationOwner,
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
  const explicitSseTimeoutMs = Number(args.sseTotalTimeoutMs);
  if (Number.isFinite(explicitSseTimeoutMs) && explicitSseTimeoutMs > 0) {
    totalTimeoutMs = totalTimeoutMs === undefined
      ? explicitSseTimeoutMs
      : Math.max(totalTimeoutMs, explicitSseTimeoutMs);
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

  const finalizeStreamEndContinuationRetention = async (): Promise<void> => {
    const closeAction = planResponsesContinuationCloseActionForHttp({
      entryEndpoint,
      requestContextPresent: Boolean(effectiveResponsesRequestContext),
      probe: contractProbe.probe,
    });
    if (closeAction.action !== 'persist_continuation') {
      return;
    }
    logResponsesContinuationTrace('stream_end.persist_continuation', requestLabel, {
      closeBeforeStreamEnd: false,
      streamEnded: true,
    });
    await finalizeResponsesConversationRequestRetentionForHttp(requestLabel, {
      keepForSubmitToolOutputs: closeAction.keepForSubmitToolOutputs,
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

  let lastProjectedClientFrameSummary: Record<string, unknown> | null = null;
  let lastRawClientFrameSummary: Record<string, unknown> | null = null;

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
    releaseMetadataCenterForHttpResponse(resultMetadata, `sse_${trigger}_closeout`);
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
    args.logResponseCompleted({
      status,
      mode: 'sse',
      ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
    });
  };

  let ssePending = '';
  let clientWriteQueue = Promise.resolve();
  const responsesSseProjectionState: ResponsesSseClientProjectionState = {
    pendingApplyPatchArgumentDeltas: {},
    applyPatchCallIds: [],
    emittedApplyPatchDoneCallIds: [],
  };
  const projectClientSseFrame = (frame: string, stage: string): Promise<string> =>
    withSseClientProjectionTimeout(
      normalizeResponsesSseFrameForClient({
        frame,
        entryEndpoint,
        directPassthrough: isDirectPassthrough,
        requestContext: effectiveResponsesRequestContext,
        metadata: responseProjectionMetadata,
        projectionState: responsesSseProjectionState,
        requestLabel,
      }),
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
        updateContractProbeFromSseChunk(normalizedFrame, contractProbe);
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
    if (isDirectPassthrough || !terminalWatch.terminalSource || ended || streamEnded || terminalFlushTimer) {
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
    args.logResponseCompleted({
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
      sawResponsesCompletedChunk: isDirectPassthrough ? true : terminalWatch.sawResponsesCompletedChunk === true,
      sawResponsesDoneEvent: isDirectPassthrough ? true : terminalWatch.sawResponsesDoneEvent === true,
      sawTerminalEvent: finishTracker.seenTerminalEvent === true,
    });
    const repairedTerminalFrames = streamEndRepairPlan.shouldRepairTerminalFrames
      ? buildResponsesTerminalSseFramesFromProbeForHttp(contractProbe.probe, requestLabel)
      : [];
    if (repairedTerminalFrames.length > 0 && !res.writableEnded && !res.destroyed) {
      try {
        for (const frame of repairedTerminalFrames) {
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
        finishTracker.seenTerminalEvent = true;
        terminalWatch.sawTerminalChunk = true;
        terminalWatch.sawResponsesCompletedChunk = terminalWatch.sawResponsesCompletedChunk || repairedTerminalFrames.some((frame: string) => frame.includes('event: response.completed'));
        terminalWatch.sawResponsesDoneEvent = terminalWatch.sawResponsesDoneEvent || repairedTerminalFrames.some((frame: string) => frame.includes('event: response.done'));
        contractProbe.emitted = true;
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
        await finalizeStreamEndContinuationRetention().catch((error) => {
          logResponseNonBlockingError(`responses-conversation-native-sse-finalize:${requestLabel}`, error);
        });
        const closedBeforeTerminalEvent = !finishTracker.seenTerminalEvent;
        const closedBeforeTerminalRepairPlan = planResponsesStreamEndRepairForHttp({
          entryEndpoint,
          probe: contractProbe.probe,
          sawResponsesCompletedChunk: isDirectPassthrough ? true : terminalWatch.sawResponsesCompletedChunk === true,
          sawResponsesDoneEvent: isDirectPassthrough ? true : terminalWatch.sawResponsesDoneEvent === true,
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
          sawResponsesCompletedChunk: isDirectPassthrough ? true : terminalWatch.sawResponsesCompletedChunk === true,
          sawResponsesDoneEvent: isDirectPassthrough ? true : terminalWatch.sawResponsesDoneEvent === true,
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
            code: incompleteCode,
            lastRawFrame: lastRawClientFrameSummary ?? undefined,
            lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
            probe: summarizeResponsesProbeForLog(contractProbe.probe),
            pendingTerminalEvent: terminalWatch.pendingTerminalEvent,
            terminalSource: terminalWatch.terminalSource,
            sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
            sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
            finishReason: resolvedStreamFinishReason,
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
          // G6: upstream_stream_incomplete without emitted semantic frames must
          // surface as Error so executor catch-chain enters decideDirectRouterRetry
          // -> provider-switch. Already-emitted frames = fail-fast, no reroute.
          const hasEmittedSemanticFrames = clientSemanticFrameWritten === true
            || terminalWatch.sawResponsesCompletedChunk === true
            || terminalWatch.sawResponsesDoneEvent === true
            || contractProbe.emitted === true;
          if (!hasEmittedSemanticFrames) {
            const upstreamError = new Error(`upstream stream incomplete: ${incompleteMessage}`);
            (upstreamError as Error & Record<string, unknown>).code = 'UPSTREAM_STREAM_INCOMPLETE';
            (upstreamError as Error & Record<string, unknown>).statusCode = 502;
            (upstreamError as Error & Record<string, unknown>).providerKey = result.usageLogInfo?.providerKey;
            (upstreamError as Error & Record<string, unknown>).requestId = requestLabel;
            throw upstreamError;
          }
          // G4: started-stream with partial semantic frames must still surface
          // the upstream_stream_incomplete error to the client via an explicit
          // `event: error` frame, then close the stream. We re-use the same
          // payload builder used for the non-emitted path so the client-visible
          // code and message stay identical to the throw path.
          if (!res.writableEnded && !res.destroyed) {
            try {
              const errorFramePayload = buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel);
              writeClientSseFrame(
                `event: error\ndata: ${JSON.stringify(errorFramePayload)}\n\n`,
                'response.sse.stream_incomplete.write_error_event'
              );
            } catch (writeError) {
              logResponseNonBlockingError(
                `response.sse.stream_incomplete.write_error_event:${requestLabel}`,
                writeError
              );
            }
          }
          args.logResponseCompleted({
            status: 502,
            mode: 'sse',
            reason: 'upstream_stream_incomplete',
            bridgeStatus: 502,
            finishReason: 'incomplete',
          });
          logPipelineStage('response.sse.stream.incomplete_internal_error', requestLabel, {
            message: incompleteMessage,
            code: incompleteCode,
            clientErrorSuppressed: true,
            lastRawFrame: lastRawClientFrameSummary ?? undefined,
            lastProjectedFrame: lastProjectedClientFrameSummary ?? undefined,
            probe: summarizeResponsesProbeForLog(contractProbe.probe),
            pendingTerminalEvent: terminalWatch.pendingTerminalEvent,
            terminalSource: terminalWatch.terminalSource,
            sawResponsesCompletedChunk: terminalWatch.sawResponsesCompletedChunk === true,
            sawResponsesDoneEvent: terminalWatch.sawResponsesDoneEvent === true,
            finishReason: resolvedStreamFinishReason,
          });
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
  return true;
}
