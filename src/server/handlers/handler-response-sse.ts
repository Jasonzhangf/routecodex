import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import {
  applyHeaders,
  assertClientResponseHasNoInternalCarriers,
  createClientSseSnapshotRecorder,
  finalizeSseTransportCloseout,
  logResponseNonBlockingError,
  maybeAttachClientSseSnapshotStream,
  recordSseTransportClientClose,
  recordSseTransportStreamEnd,
  recordSseTransportStreamStart,
  shouldCaptureClientResponseSnapshotStage,
  toNodeReadable,
  type ClientSseSnapshotRecorder,
  type DispatchOptions,
  type ResponsesRequestContext,
} from './handler-response-common.js';
import { logPipelineStage } from '../utils/stage-logger.js';
import { extractUsageFromResult } from '../runtime/http-server/executor/usage-aggregator.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { isClientDisconnectAbortError } from '../runtime/http-server/executor-provider.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp,
  assertDirectPassthroughResponsesSseFrameForHttp,
  sanitizeDirectPassthroughResponsesSseFrameForHttp,
  buildClientSseKeepaliveFrameForHttp,
  buildResponsesMissingSseBridgeErrorPayloadForHttp,
  buildResponsesSseErrorPayloadForHttp,
  buildResponsesStructuredSseErrorPayloadForHttp,
  createResponsesJsonToSseConverterForHttp,
  isDirectPassthroughTransportKeepaliveFrameForHttp,
  shouldDropClientSseFrameForHttp,
} from '../../modules/llmswitch/bridge/responses-sse-bridge.js';
import {
  normalizeClientVisibleResponsesSseFrameForHttp,
  type ResponsesSseClientProjectionStateForHttp,
} from '../../modules/llmswitch/bridge/responses-client-projection.js';
import {
  createChatJsonToSseConverterForHttp,
} from '../../modules/llmswitch/bridge/responses-response-bridge.js';

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

type SendSsePipelineResponseArgs = {
  res: Response;
  result: PipelineExecutionResult;
  requestLabel: string;
  status: number;
  body: unknown;
  forceSSE: boolean;
  expectsStream: boolean;
  entryEndpoint?: string;
  entryPort?: number;
  snapshotGroupRequestId?: string;
  snapshotEntryPort?: number;
  sseTotalTimeoutMs?: number;
  preparedResponsesJsonSseDispatch?: {
    responsesPayload: Record<string, unknown>;
  };
  responsesRequestContext?: ResponsesRequestContext;
  logResponseCompleted: (details?: Record<string, unknown>) => void;
};

type ResponsesJsonSseDispatchArgs = {
  res: Response;
  requestLabel: string;
  result: PipelineExecutionResult;
  status: number;
  entryEndpoint?: string;
  preparedResponsesJsonSseDispatch?: {
    responsesPayload: Record<string, unknown>;
  };
  responsesRequestContext?: DispatchOptions['responsesRequestContext'];
  logResponseCompleted: (details?: Record<string, unknown>) => void;
};

const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';
const DEFAULT_SSE_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_SSE_PROJECTION_TIMEOUT_MS = 5_000;

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

function logResponsesSseTransportTrace(
  stage: string,
  requestLabel: string,
  details?: Record<string, unknown>
): void {
  if ((process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() !== '1') {
    return;
  }
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    console.warn(`[responses-sse-transport] ${stage} request=${requestLabel}${suffix}`);
  } catch {
    console.warn(`[responses-sse-transport] ${stage} request=${requestLabel}`);
  }
}

function logSseFrameProjection(requestLabel: string, stage: string, frame: string): void {
  if (!frame) {
    return;
  }
  logPipelineStage(stage, requestLabel, { emit: true });
}

function writeSseDiagnosticSnapshot(
  requestLabel: string,
  entryEndpoint: string | undefined,
  entryPort: number | undefined,
  groupRequestId: string | undefined,
  reason: string,
  data: Record<string, unknown>
): void {
  if (!shouldCaptureClientResponseSnapshotStage('client-response.error')) {
    return;
  }
  void writeServerSnapshot({
    phase: 'client-response.error',
    requestId: requestLabel,
    groupRequestId,
    entryEndpoint,
    entryPort,
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
    providerProtocol: undefined
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
      const sanitized = sanitizeDirectPassthroughResponsesSseFrameForHttp(frame, requestId);
      assertDirectPassthroughResponsesSseMetadataIsolationForHttp(sanitized, requestId);
      target.push(sanitized);
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
          const sanitized = sanitizeDirectPassthroughResponsesSseFrameForHttp(pending, requestId);
          assertDirectPassthroughResponsesSseMetadataIsolationForHttp(sanitized, requestId);
          this.push(sanitized);
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
  finalizeSseTransportCloseout({
    metadata,
    releaseReason,
  });
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
  finalizeSseTransportCloseout({
    metadata,
    releaseReason,
  });
}

async function normalizeResponsesSseFrameForClient(args: {
  frame: string;
  entryEndpoint?: string;
  requestContext?: DispatchOptions['responsesRequestContext'];
  metadata?: Record<string, unknown>;
  projectionState?: ResponsesSseClientProjectionStateForHttp;
  requestLabel?: string;
}): Promise<string> {
  return await normalizeClientVisibleResponsesSseFrameForHttp({
    frame: args.frame,
    entryEndpoint: args.entryEndpoint,
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
  const projectionState: ResponsesSseClientProjectionStateForHttp = {
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
  let cleanupLogged = false;
  let streamEnded = false;
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
    const sse = await converter.convertResponseToJsonToSse(args.responsesPayload, {
      requestId: args.requestLabel
    });
    const rawStream = toNodeReadable(sse);
    const stream = rawStream
      ? createResponsesClientProjectionStream({
        stream: rawStream,
        entryEndpoint: args.entryEndpoint,
        requestContext: args.responsesRequestContext,
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
    const cleanup = (trigger: 'close' | 'finish') => {
      if (cleanupLogged) {
        return;
      }
      cleanupLogged = true;
      if (trigger === 'close' && !streamEnded) {
        recordSseTransportClientClose(args.requestLabel, {
          finishReason: undefined,
          terminal: false,
          closeBeforeStreamEnd: true,
        });
        try {
          stream.unpipe(args.res);
        } catch (error) {
          logResponseNonBlockingError(`response.sse.json_bridge.unpipe:${args.requestLabel}`, error);
        }
        try {
          stream.destroy(createSseClientResponseClosedError());
        } catch (error) {
          logResponseNonBlockingError(`response.sse.json_bridge.destroy:${args.requestLabel}`, error);
        }
      }
      finalizeSseTransportCloseout({
        metadata: args.result.metadata as Record<string, unknown> | undefined,
        releaseReason: `json_to_sse_${trigger}_closeout`,
        logResponseCompleted: args.logResponseCompleted,
        completedDetails: {
          status: args.status,
          mode: 'sse',
        },
      });
    };
    stream.on('end', () => {
      streamEnded = true;
      if (!args.res.writableEnded && !args.res.destroyed) {
        args.res.end();
      }
      cleanup('finish');
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
    args.res.on('close', () => cleanup('close'));
    args.res.on('finish', () => cleanup('finish'));
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
  let cleanupLogged = false;
  let streamEnded = false;
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
    const cleanup = (trigger: 'close' | 'finish') => {
      if (cleanupLogged) {
        return;
      }
      cleanupLogged = true;
      if (trigger === 'close' && !streamEnded) {
        recordSseTransportClientClose(args.requestLabel, {
          finishReason: undefined,
          terminal: false,
          closeBeforeStreamEnd: true,
        });
        try {
          stream.unpipe(args.res);
        } catch (error) {
          logResponseNonBlockingError(`response.sse.chat_json_bridge.unpipe:${args.requestLabel}`, error);
        }
        try {
          stream.destroy(createSseClientResponseClosedError());
        } catch (error) {
          logResponseNonBlockingError(`response.sse.chat_json_bridge.destroy:${args.requestLabel}`, error);
        }
      }
      finalizeSseTransportCloseout({
        metadata: args.result.metadata as Record<string, unknown> | undefined,
        releaseReason: `json_to_sse_${trigger}_closeout`,
        logResponseCompleted: args.logResponseCompleted,
        completedDetails: {
          status: args.status,
          mode: 'sse',
        },
      });
    };
    stream.on('end', () => {
      streamEnded = true;
      if (!args.res.writableEnded && !args.res.destroyed) {
        args.res.end();
      }
      cleanup('finish');
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
    args.res.on('close', () => cleanup('close'));
    args.res.on('finish', () => cleanup('finish'));
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
  const responsesPayload = args.preparedResponsesJsonSseDispatch?.responsesPayload;
  if (!responsesPayload) {
    return false;
  }
  return streamResponsesJsonAsSse({
    ...args,
    responsesPayload,
  });
}

export async function sendSsePipelineResponse(args: SendSsePipelineResponseArgs): Promise<boolean | Error> {
  const { res, result, requestLabel, status, body, forceSSE, expectsStream, entryEndpoint } = args;
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
      preparedResponsesJsonSseDispatch: args.preparedResponsesJsonSseDispatch,
      responsesRequestContext: args.responsesRequestContext,
      logResponseCompleted: args.logResponseCompleted
    })) {
      return true;
    }
    logPipelineStage('response.sse.missing', requestLabel, { status });
    const structuredErrorPayload = extractStructuredSseErrorPayload(body, requestLabel, status);
    finalizeSseTransportCloseout({
      releaseReason: 'force_sse_missing_stream_observed',
      logResponseCompleted: args.logResponseCompleted,
      completedDetails: {
        status: 200,
        mode: 'sse',
        reason: structuredErrorPayload ? 'structured_error_passthrough' : 'missing_stream',
        bridgeStatus: structuredErrorPayload ? status : 502
      },
    });
    if (shouldCaptureClientResponseSnapshotStage('client-response.error')) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: requestLabel,
        groupRequestId: args.snapshotGroupRequestId,
        entryEndpoint,
        entryPort: args.snapshotEntryPort,
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
    finalizeSseTransportCloseout({
      metadata: resultMetadata,
      releaseReason: 'missing_stream_observed',
      logResponseCompleted: args.logResponseCompleted,
      completedDetails: { status: 200, mode: 'sse', reason: 'missing_stream', bridgeStatus: 502 },
    });
    if (shouldCaptureClientResponseSnapshotStage('client-response.error')) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: requestLabel,
        groupRequestId: args.snapshotGroupRequestId,
        entryEndpoint,
        entryPort: args.snapshotEntryPort,
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
      groupRequestId: args.snapshotGroupRequestId,
      entryEndpoint,
      entryPort: args.entryPort,
      status,
      headers: result.headers,
      metadata: resultMetadata,
      usageEntryPort: result.usageLogInfo?.entryPort
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
    recordSseTransportClientClose(requestLabel, {
      finishReason: details.finishReason,
      terminal: false,
      closeBeforeStreamEnd: true
    });
    logSseClientCloseDiagnosis(requestLabel, details);
    logPipelineStage('response.sse.client_close', requestLabel, details);
    writeSseDiagnosticSnapshot(
      requestLabel,
      entryEndpoint,
      args.snapshotEntryPort,
      args.snapshotGroupRequestId,
      'prestart_client_close',
      {
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
      }
    );
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
    finalizeSseTransportCloseout({
      metadata: resultMetadata,
      releaseReason: 'sse_prestart_client_close',
    });
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
  recordSseTransportStreamStart(requestLabel);

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
    logSseFrameProjection(requestLabel, 'response.sse.write_frame', frame);
    try {
      res.write(frame);
    } catch (error) {
      logResponseNonBlockingError(`${errorLabel}:${requestLabel}`, error);
    }
  };

  let ended = false;
  let cleanupLogged = false;
  let streamEnded = false;
  let totalTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;

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
  const detachOutboundStream = () => {
    try {
      outboundStream.unpipe(res);
    } catch (error) {
      logResponseNonBlockingError(`response.sse.unpipe:${requestLabel}`, error);
    }
  };
  const destroySourceStream = (error?: Error) => {
    const destroyTarget =
      streamSource && typeof (streamSource as { destroy?: unknown }).destroy === 'function'
        ? streamSource as Readable
        : stream;
    try {
      if (error && typeof destroyTarget.once === 'function') {
        destroyTarget.once('error', (streamError) => {
          const streamCode = readErrorCode(streamError);
          const expectedCode = readErrorCode(error);
          const sameCode = expectedCode && streamCode === expectedCode;
          const sameMessage =
            streamError instanceof Error
            && streamError.message === error.message;
          if (sameCode || sameMessage || isClientDisconnectAbortError(streamError)) {
            return;
          }
          logResponseNonBlockingError(`response.sse.cleanup.destroy_stream:${requestLabel}`, streamError);
        });
      }
      destroyTarget.destroy?.(error);
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
    destroySourceStream(abortError);
  };
  const runClientCloseBeforeTerminalCleanup = (closeBeforeStreamEnd: boolean) => {
    abortSourceStreamForClientClose();
    logResponsesSseTransportTrace('client_close.transport_only', requestLabel, {
      closeBeforeStreamEnd,
      detectedBeforeStreamStart: !streamEnded
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
  };

  const endWithSseError = (code: string, message: string, statusCode = 504, logLabel = 'response.sse.stream.timeout') => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimers();
    detachOutboundStream();
    logPipelineStage(logLabel, requestLabel, { code, message });
    writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, args.snapshotEntryPort, args.snapshotGroupRequestId, code, {
      status: statusCode,
      message,
      streamEnded,
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
    destroySourceStream(Object.assign(new Error(message), { code }));
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
    const closeBeforeStreamEnd = trigger === 'close' && !streamEnded;
    const details = {
      status,
      trigger,
      streamEnded,
    };
    finalizeSseTransportCloseout({
      metadata: resultMetadata,
      releaseReason: `sse_${trigger}_closeout`,
    });
    if (closeBeforeStreamEnd) {
      logSseClientCloseDiagnosis(requestLabel, {
        ...details,
        closeBeforeStreamEnd
      });
      logPipelineStage('response.sse.client_close', requestLabel, {
        ...details,
        closeBeforeStreamEnd
      });
      writeSseDiagnosticSnapshot(
        requestLabel,
        entryEndpoint,
        args.snapshotEntryPort,
        args.snapshotGroupRequestId,
        'client_close_before_terminal',
        {
        ...details,
        closeBeforeStreamEnd
        }
      );
      runClientCloseBeforeTerminalCleanup(closeBeforeStreamEnd);
      return;
    }
    logPipelineStage('response.sse.stream.end', requestLabel, details);
    finalizeSseTransportCloseout({
      logResponseCompleted: args.logResponseCompleted,
      completedDetails: {
        status,
        mode: 'sse',
      },
    });
  };

  let ssePending = '';
  let clientWriteQueue = Promise.resolve();
  const responsesSseProjectionState: ResponsesSseClientProjectionStateForHttp = {
    pendingApplyPatchArgumentDeltas: {},
    applyPatchCallIds: [],
    emittedApplyPatchDoneCallIds: [],
  };
  const projectClientSseFrame = (frame: string, stage: string): Promise<string> =>
    withSseClientProjectionTimeout(
      normalizeResponsesSseFrameForClient({
        frame,
        entryEndpoint,
        requestContext: args.responsesRequestContext,
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
            emit: false
          });
          return;
        }
        logPipelineStage('response.sse.project_frame', requestLabel, {
          emit: true
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
        });
        endWithSseError(
          readErrorCode(projectionError) ?? 'SSE_CLIENT_PROJECTION_FAILED',
          'SSE stream response projection failed',
          500,
          'response.sse.projection.error'
        );
      });
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
      enqueueClientSseFrame(frame, 'response.sse.stream.write_frame');
    }
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
    recordSseTransportClientClose(requestLabel, {
      finishReason: undefined,
      terminal: false,
      closeBeforeStreamEnd: !streamEnded
    });
    logPipelineStage('response.sse.stream.error', requestLabel, { message: error.message });
    writeSseDiagnosticSnapshot(
      requestLabel,
      entryEndpoint,
      args.snapshotEntryPort,
      args.snapshotGroupRequestId,
      'stream_error',
      {
      status: 500,
      message: error.message,
      code: readErrorCode(error),
      streamEnded,
      }
    );
    finalizeSseTransportCloseout({
      metadata: resultMetadata,
      releaseReason: 'sse_stream_error_closeout',
      logResponseCompleted: args.logResponseCompleted,
      completedDetails: {
        status: 500,
        mode: 'sse',
        reason: 'stream_error',
      },
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
    recordSseTransportStreamEnd(requestLabel, {
      finishReason: undefined,
      terminal: false
    });
    if (ssePending.trim()) {
      const pendingFrame = `${ssePending}\n\n`;
      maybeUpdateUsageLogInfoFromSseFrame(result, pendingFrame);
      enqueueClientSseFrame(pendingFrame, 'response.sse.stream.write_pending_frame');
      ssePending = '';
    }
    try {
      await clientWriteQueue;
    } catch (error) {
      logResponseNonBlockingError(`response.sse.stream.end.flush_queue:${requestLabel}`, error);
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

  res.on('close', () => {
    abortSourceStreamForClientClose();
    if (!streamEnded) {
      recordSseTransportClientClose(requestLabel, {
        finishReason: undefined,
        terminal: false,
        closeBeforeStreamEnd: true
      });
    }
    cleanup('close');
  });
  res.on('finish', () => cleanup('finish'));
  return true;
}
