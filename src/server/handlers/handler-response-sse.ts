import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import {
  applyHeaders,
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
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { isClientDisconnectAbortError } from '../runtime/http-server/executor-provider.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  buildClientSseKeepaliveFrameForHttp,
  buildResponsesMissingSseBridgeErrorPayloadForHttp,
  buildResponsesSseErrorPayloadForHttp,
  buildResponsesStructuredSseErrorPayloadForHttp,
  createResponsesJsonToSseConverterForHttp,
} from '../../modules/llmswitch/bridge/responses-sse-bridge.js';
import {
  createChatJsonToSseConverterForHttp,
  buildResponsesPayloadFromChatForHttp,
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

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
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
      const responseClosedBeforeStreamEnd = !streamEnded;
      try {
        stream.unpipe(args.res);
      } catch (error) {
        logResponseNonBlockingError(`response.sse.json_bridge.unpipe:${args.requestLabel}`, error);
      }
      if (responseClosedBeforeStreamEnd) {
        recordSseTransportClientClose(args.requestLabel, {
          finishReason: undefined,
          terminal: false,
          closeBeforeStreamEnd: true,
        });
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
      const responseClosedBeforeStreamEnd = !streamEnded;
      try {
        stream.unpipe(args.res);
      } catch (error) {
        logResponseNonBlockingError(`response.sse.chat_json_bridge.unpipe:${args.requestLabel}`, error);
      }
      if (responseClosedBeforeStreamEnd) {
        recordSseTransportClientClose(args.requestLabel, {
          finishReason: undefined,
          terminal: false,
          closeBeforeStreamEnd: true,
        });
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
  const body = args.result.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  const responsesPayload =
    record.object === 'response'
      ? record
      : (
        args.entryEndpoint === '/v1/responses'
        && record.object === 'chat.completion'
          ? await buildResponsesPayloadFromChatForHttp(body, {
            requestId: args.requestLabel,
          }) as Record<string, unknown>
          : undefined
      );
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
  const clientConnectionState =
    resultMetadata?.clientConnectionState
    && typeof resultMetadata.clientConnectionState === 'object'
    && !Array.isArray(resultMetadata.clientConnectionState)
      ? resultMetadata.clientConnectionState as { disconnected?: unknown }
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
  try {
    stream.pause?.();
  } catch (error) {
    logResponseNonBlockingError(`response.sse.pause_source:${requestLabel}`, error);
  }
  const clientSseSnapshotRecorder = shouldCaptureClientResponseSnapshotStage('client-response')
    ? createClientSseSnapshotRecorder(stream, res, {
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
    ? maybeAttachClientSseSnapshotStream(stream, clientSseSnapshotRecorder)
    : stream;
  const clientConnectionDisconnected = clientConnectionState?.disconnected === true;
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
    clientConnectionDisconnected,
  });
  const preStartClientClosed =
    clientConnectionDisconnected
    && (
      res.destroyed
      || (res as unknown as { writableEnded?: boolean }).writableEnded === true
      || (res as unknown as { writableFinished?: boolean }).writableFinished === true
    );
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
      clientConnectionDisconnected,
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
      ended
      || res.destroyed
      || (res as unknown as { writableEnded?: boolean }).writableEnded === true
      || (res as unknown as { writableFinished?: boolean }).writableFinished === true
    ) {
      logPipelineStage('response.sse.write_frame.skipped_closed_response', requestLabel, {
        errorLabel,
      });
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

  const cleanup = async (trigger: 'close' | 'finish') => {
    if (cleanupLogged) {
      return;
    }
    cleanupLogged = true;
    if (trigger === 'close') {
      ended = true;
    }
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

  outboundStream.on('data', (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8')
      : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8')
      : '';
    if (!text) return;
    writeClientSseFrame(text, 'response.sse.stream.write_frame', { recordSnapshot: false });
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
      const payload = buildResponsesSseErrorPayloadForHttp({
        requestLabel,
        status: 500,
        message: error.message,
        code: readErrorCode(error) ?? 'sse_stream_error',
      });
      writeClientSseFrame(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, 'response.sse.stream_error.write_error_event');
    } catch (writeError) {
      logResponseNonBlockingError(`response.sse.stream_error.write_error_event:${requestLabel}`, writeError);
    }
    ended = true;
    try {
      res.end();
    } catch (endError) {
      logResponseNonBlockingError(`response.sse.stream_error.end:${requestLabel}`, endError);
    }
    clientSseSnapshotRecorder?.flush(error);
  });

  outboundStream.on('end', async () => {
    streamEnded = true;
    clearTimers();
    recordSseTransportStreamEnd(requestLabel, {
      finishReason: undefined,
      terminal: false
    });
    ended = true;
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
    if (!ended && !streamEnded) {
      abortSourceStreamForClientClose();
      recordSseTransportClientClose(requestLabel, {
        finishReason: undefined,
        terminal: false,
        closeBeforeStreamEnd: true
      });
      void cleanup('close');
    }
  });
  res.on('finish', () => {
    void cleanup('finish');
  });
  try {
    stream.resume?.();
  } catch (error) {
    logResponseNonBlockingError(`response.sse.resume_source:${requestLabel}`, error);
  }
  return true;
}
