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
import { normalizeUsage, type UsageMetrics } from '../runtime/http-server/executor/usage-aggregator.js';
import { buildSseErrorEventFrame } from '../utils/http-error-mapper.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  buildClientSseKeepaliveFrameForHttp,
  createResponsesSseClientProjectionStateForHttp,
  projectResponsesSseFrameForClientForHttp,
  updateResponsesSseTransportTerminalStateForHttp,
} from '../../modules/llmswitch/bridge/responses-sse-bridge.js';

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

type SendSsePipelineResponseArgs = {
  res: Response;
  result: PipelineExecutionResult;
  requestLabel: string;
  status: number;
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

const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';
const DEFAULT_SSE_TOTAL_TIMEOUT_MS = 300_000;

function isResponsesSseEndpoint(entryEndpoint: string | undefined): boolean {
  return entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs';
}

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

function parseClientSseProjectionFrame(frame: string): {
  eventName?: string;
  data: Record<string, unknown>;
} | undefined {
  const lines = frame.split(/\r?\n/);
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) {
    return undefined;
  }
  const dataText = dataLines
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return undefined;
  }
  const parsed = JSON.parse(dataText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return {
    eventName: eventLine?.slice('event:'.length).trim() || undefined,
    data: parsed as Record<string, unknown>,
  };
}

function readSseFrameUsage(parsed: { eventName?: string; data: Record<string, unknown> } | undefined): {
  usage?: UsageMetrics;
  finishReason?: string;
} {
  if (!parsed) {
    return {};
  }
  const data = parsed.data;
  const response = data.response && typeof data.response === 'object' && !Array.isArray(data.response)
    ? data.response as Record<string, unknown>
    : undefined;
  const message = data.message && typeof data.message === 'object' && !Array.isArray(data.message)
    ? data.message as Record<string, unknown>
    : undefined;
  const delta = data.delta && typeof data.delta === 'object' && !Array.isArray(data.delta)
    ? data.delta as Record<string, unknown>
    : undefined;
  const sourceProtocol =
    parsed.eventName?.startsWith('message_') || String(data.type ?? '').startsWith('message_')
      ? 'anthropic'
      : parsed.eventName?.startsWith('response.') || String(data.type ?? '').startsWith('response.')
        ? 'openai-responses'
        : undefined;
  const usage = normalizeUsage(response?.usage ?? data.usage ?? message?.usage, { sourceProtocol });
  const finishReasonRaw =
    delta?.stop_reason
    ?? data.stop_reason
    ?? response?.finish_reason
    ?? response?.finishReason
    ?? data.finish_reason
    ?? data.finishReason;
  const finishReason = typeof finishReasonRaw === 'string' && finishReasonRaw.trim()
    ? finishReasonRaw.trim()
    : undefined;
  return { usage, finishReason };
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
  frame: string,
  metadata?: Record<string, unknown>,
  releaseReason = 'sse_bridge_error_closeout'
): void {
  if (!res.headersSent) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
  }
  try {
    res.write(frame);
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

export async function sendSsePipelineResponse(args: SendSsePipelineResponseArgs): Promise<boolean | Error> {
  const { res, result, requestLabel, status, forceSSE, expectsStream, entryEndpoint } = args;
  if (forceSSE && result.sseStream === undefined) {
    const missingSseError = buildSseErrorEventFrame({
      requestId: requestLabel,
      status: 502,
      message: 'SSE stream missing from pipeline result',
      code: 'sse_bridge_error',
    });
    const missingSsePayload = missingSseError.payload;
    logPipelineStage('response.sse.missing', requestLabel, { status });
    finalizeSseTransportCloseout({
      releaseReason: 'force_sse_missing_stream_observed',
      logResponseCompleted: args.logResponseCompleted,
      completedDetails: {
        status: 200,
        mode: 'sse',
        reason: 'missing_stream',
        bridgeStatus: 502
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
          payload: missingSsePayload
        }
      }).catch((error) => {
        logResponseNonBlockingError(`writeServerSnapshot:sse_missing:${requestLabel}`, error);
      });
    }
    sendSseBridgeError(
      res,
      requestLabel,
      missingSseError.frame,
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
    const missingSseError = buildSseErrorEventFrame({
      requestId: requestLabel,
      status: 502,
      message: 'SSE stream missing from pipeline result',
      code: 'sse_bridge_error',
    });
    const missingSsePayload = missingSseError.payload;
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
      missingSseError.frame,
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
      const flush = (res as FlushableResponse).flush;
      if (typeof flush === 'function') {
        flush.call(res);
      }
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
  const toolsRaw = Array.isArray(args.responsesRequestContext?.context?.toolsRaw)
    ? args.responsesRequestContext.context.toolsRaw
    : [];
  let projectionState = createResponsesSseClientProjectionStateForHttp();
  let sseTransportTerminalState: Record<string, unknown> | undefined;
  let sseSemanticTerminalObserved = false;
  let sseDoneSentinelObserved = false;
  let pendingSseFrameBuffer = '';
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
    clearTimers();
    detachOutboundStream();
    logPipelineStage(logLabel, requestLabel, { code, message });
    writeSseDiagnosticSnapshot(requestLabel, entryEndpoint, args.snapshotEntryPort, args.snapshotGroupRequestId, code, {
      status: statusCode,
      message,
      streamEnded,
    });
    const { frame } = buildSseErrorEventFrame({
      requestId: requestLabel,
      status: statusCode,
      message,
      code,
    });
    writeClientSseFrame(frame, 'response.sse.error.write_error_event');
    ended = true;
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
    const closeBeforeStreamEnd =
      trigger === 'close'
      && !streamEnded
      && !sseSemanticTerminalObserved;
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

  let sseFinishReason: string | undefined;
  const updateTransportTerminalStateFromFrame = (frame: string) => {
    if (!isResponsesSseEndpoint(entryEndpoint)) {
      return;
    }
    const terminalState = updateResponsesSseTransportTerminalStateForHttp({
      chunk: frame,
      state: sseTransportTerminalState,
      flushRemainder: true,
    });
    sseTransportTerminalState = terminalState.state;
    sseSemanticTerminalObserved = sseSemanticTerminalObserved || terminalState.observedTerminal;
  };
  const writeProjectedClientSseFrame = (frame: string) => {
    const parsed = parseClientSseProjectionFrame(frame);
    if (frame.includes('data: [DONE]')) {
      sseDoneSentinelObserved = true;
    }
    const usageFrame = readSseFrameUsage(parsed);
    if (usageFrame.usage && result.usageLogInfo) {
      result.usageLogInfo.usage = usageFrame.usage as unknown as Record<string, unknown>;
    }
    if (usageFrame.finishReason) {
      sseFinishReason = usageFrame.finishReason;
      if (result.usageLogInfo) {
        result.usageLogInfo.finishReason = usageFrame.finishReason;
      }
    }
    if (isResponsesSseEndpoint(entryEndpoint)) {
      updateTransportTerminalStateFromFrame(frame);
    }
    if (
      !parsed
      || !isResponsesSseEndpoint(entryEndpoint)
      || isDirectPassthrough
    ) {
      writeClientSseFrame(frame, 'response.sse.stream.write_frame', { recordSnapshot: false });
      return;
    }
    const projection = projectResponsesSseFrameForClientForHttp({
      frame,
      eventName: parsed.eventName,
      data: parsed.data,
      toolsRaw,
      metadata: resultMetadata,
      state: projectionState,
    });
    projectionState = projection.state ?? projectionState;
    if (!projection.emit) {
      return;
    }
    writeClientSseFrame(projection.frame, 'response.sse.stream.write_projected_frame', { recordSnapshot: false });
  };

  const flushPendingSseFrames = (final = false) => {
    const parts = pendingSseFrameBuffer.split(/\r?\n\r?\n/);
    pendingSseFrameBuffer = final ? '' : (parts.pop() ?? '');
    const completeParts = final ? parts.filter((part) => part.length > 0) : parts;
    for (const part of completeParts) {
      if (!part) {
        continue;
      }
      writeProjectedClientSseFrame(`${part}\n\n`);
    }
    if (final && pendingSseFrameBuffer) {
      writeProjectedClientSseFrame(pendingSseFrameBuffer);
      pendingSseFrameBuffer = '';
    }
  };

  outboundStream.on('data', (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8')
      : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8')
      : '';
    if (!text) return;
    pendingSseFrameBuffer += text;
    flushPendingSseFrames();
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
      const { frame } = buildSseErrorEventFrame({
        requestId: requestLabel,
        status: 500,
        message: error.message,
        code: readErrorCode(error) ?? 'sse_stream_error',
      });
      writeClientSseFrame(frame, 'response.sse.stream_error.write_error_event');
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
    flushPendingSseFrames(true);
    clearTimers();
    recordSseTransportStreamEnd(requestLabel, {
      finishReason: sseFinishReason,
    });
    if (!res.writableEnded && !res.destroyed) {
      try {
        if (
          isResponsesSseEndpoint(entryEndpoint)
          && sseSemanticTerminalObserved
          && !sseDoneSentinelObserved
        ) {
          writeClientSseFrame('data: [DONE]\n\n', 'response.sse.stream.write_done_sentinel');
          sseDoneSentinelObserved = true;
        }
        ended = true;
        res.end();
      } catch (endError) {
        logResponseNonBlockingError(`response.sse.stream.end:${requestLabel}`, endError);
      }
      clientSseSnapshotRecorder?.flush();
    } else {
      ended = true;
    }
  });

  res.on('close', () => {
    if (!ended && !streamEnded) {
      recordSseTransportClientClose(requestLabel, {
        finishReason: undefined,
        closeBeforeStreamEnd: true
      });
      abortSourceStreamForClientClose();
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
