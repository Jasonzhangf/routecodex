import { Readable, PassThrough } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import { formatRequestTimingSummary, logPipelineStage } from '../utils/stage-logger.js';
import { logUsageSummary } from '../runtime/http-server/executor/usage-logger.js';
import { normalizeUsage } from '../runtime/http-server/executor/usage-aggregator.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
import { isSnapshotsEnabled, writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { buildInfo } from '../../build-info.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../utils/finish-reason.js';
import {
  colorizeRequestLog,
  formatHighlightedFinishReasonLabel,
  registerRequestLogContext
} from '../utils/request-log-color.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';

const BLOCKED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);

interface DispatchOptions {
  forceSSE?: boolean;
  entryEndpoint?: string;
  sseTotalTimeoutMs?: number;
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
  buffer: string;
  finishReason?: string;
  seenCompletedEvent: boolean;
  seenDoneEvent: boolean;
  seenDoneMarker: boolean;
  seenRequiredActionEvent: boolean;
  seenTerminalEvent: boolean;
  lastEventName?: string;
};

type ChatUsageNormalizationResult = {
  payload: unknown;
  normalized: boolean;
  source?: 'body' | 'usage_log';
};

const SHOULD_LOG_HTTP_EVENTS = buildInfo.mode !== 'release'
  || process.env.ROUTECODEX_HTTP_LOG_VERBOSE === '1';

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
  console.log(colorizeRequestLog(line, requestLabel, context));
}

function trackSseFinishReason(tracker: SseFinishReasonTracker, chunk: unknown): void {
  const text = extractChunkText(chunk);
  if (!text) {
    return;
  }
  tracker.buffer += text;
  while (true) {
    const boundaryMatch = tracker.buffer.match(/\r?\n\r?\n/);
    if (!boundaryMatch || boundaryMatch.index === undefined) {
      break;
    }
    const boundaryLength = boundaryMatch[0].length;
    const rawBlock = tracker.buffer.slice(0, boundaryMatch.index);
    tracker.buffer = tracker.buffer.slice(boundaryMatch.index + boundaryLength);
    trackSseTerminalState(tracker, rawBlock);
    const derived = deriveFinishReasonFromSseBlock(rawBlock, tracker.finishReason);
    if (derived) {
      tracker.finishReason = derived;
    }
  }
}

function trackSseTerminalState(tracker: SseFinishReasonTracker, block: string): void {
  const trimmed = block.trim();
  if (!trimmed) {
    return;
  }
  let eventName = '';
  const dataLines: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim().toLowerCase();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  tracker.lastEventName = eventName || tracker.lastEventName;
  const dataText = dataLines.join('\n').trim();
  if (dataText === '[DONE]') {
    tracker.seenDoneMarker = true;
    tracker.seenTerminalEvent = true;
  }
  if (!eventName) {
    return;
  }
  if (eventName === 'response.completed') {
    tracker.seenCompletedEvent = true;
    tracker.seenTerminalEvent = true;
    return;
  }
  if (eventName === 'response.done' || eventName === 'message_stop') {
    tracker.seenDoneEvent = true;
    tracker.seenTerminalEvent = true;
    return;
  }
  if (eventName === 'response.required_action') {
    tracker.seenRequiredActionEvent = true;
    tracker.seenTerminalEvent = true;
    return;
  }
  if (eventName === 'response.failed' || eventName === 'response.incomplete' || eventName === 'error') {
    tracker.seenTerminalEvent = true;
  }
}

function deriveFinishReasonFromSseBlock(block: string, current?: string): string | undefined {
  const trimmed = block.trim();
  if (!trimmed) {
    return current;
  }
  let eventName = '';
  const dataLines: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim().toLowerCase();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const dataText = dataLines.join('\n').trim();
  if (!dataText || dataText === '[DONE]') {
    return current;
  }
  try {
    const payload = JSON.parse(dataText) as unknown;
    return deriveFinishReasonFromSsePayload(payload, eventName) ?? current;
  } catch {
    return current;
  }
}

function deriveFinishReasonFromSsePayload(payload: unknown, eventName?: string): string | undefined {
  const direct = deriveFinishReason(payload);
  if (direct) {
    return direct;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return eventName === 'message_stop' ? 'stop' : undefined;
  }
  const record = payload as Record<string, unknown>;
  const responseFinishReason = deriveFinishReason(record.response);
  if (responseFinishReason) {
    return responseFinishReason;
  }
  const deltaFinishReason = deriveFinishReason(record.delta);
  if (deltaFinishReason) {
    return deltaFinishReason;
  }
  const messageFinishReason = deriveFinishReason(record.message);
  if (messageFinishReason) {
    return messageFinishReason;
  }
  if (eventName === 'message_stop') {
    return 'stop';
  }
  return undefined;
}

function extractChunkText(chunk: unknown): string | undefined {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return undefined;
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
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
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

export function hasSsePayload(body: unknown): body is SsePayloadShape {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
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

export function sendPipelineResponse(
  res: Response,
  result: PipelineExecutionResult,
  requestId?: string,
  options?: DispatchOptions
): void {
  const status = typeof result.status === 'number' ? result.status : 200;
  const body = result.body;
  const requestLabel = formatRequestId(requestId);
  const forceSSE = options?.forceSSE === true;
  const expectsStream = hasSsePayload(body);
  const entryEndpoint = typeof options?.entryEndpoint === 'string' && options.entryEndpoint.trim()
    ? options.entryEndpoint.trim()
    : undefined;
  const requestLogContext = {
    sessionId: result.usageLogInfo?.sessionId,
    conversationId: result.usageLogInfo?.conversationId
  };
  registerRequestLogContext(requestLabel, requestLogContext);
  const captureClientResponse = shouldCaptureClientStreamSnapshots();
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
        providerAttemptCount: usageLogInfo.providerAttemptCount,
        retryCount: usageLogInfo.retryCount,
        hubStageTop: usageLogInfo.hubStageTop as any,
        latencyMs: Date.now() - usageLogInfo.requestStartedAtMs,
        timingRequestIds: usageLogInfo.timingRequestIds,
        sessionId: usageLogInfo.sessionId,
        conversationId: usageLogInfo.conversationId,
        projectPath: usageLogInfo.projectPath
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
    logPipelineStage('response.sse.missing', requestLabel, { status });
    logResponseCompleted({ status: 200, mode: 'sse', reason: 'missing_stream', bridgeStatus: 502 });
    if (captureClientResponse) {
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
        logResponseNonBlockingError(`writeServerSnapshot:sse_missing:${requestLabel}`, error);
      });
    }
    sendSseBridgeError(res, requestLabel, 502);
    return;
  }

  logPipelineStage('response.dispatch.start', requestLabel, { status, stream: expectsStream, forced: forceSSE });

  if (expectsStream) {
    const streamSource = body.__sse_responses;
    const stream = toNodeReadable(streamSource);
    if (!stream) {
      logPipelineStage('response.sse.missing', requestLabel, {});
      logResponseCompleted({ status: 200, mode: 'sse', reason: 'missing_stream', bridgeStatus: 502 });
      if (captureClientResponse) {
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
    const outboundStream = captureClientResponse
      ? maybeAttachClientSseSnapshotStream(stream, {
        requestId: requestLabel,
        entryEndpoint,
        status,
        headers: result.headers
      })
      : stream;
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

    let eventCount = 0;
    let ended = false;
    let completedLogged = false;
    let cleanupLogged = false;
    let streamEnded = false;
    const finishTracker: SseFinishReasonTracker = {
      buffer: '',
      finishReason:
        body && typeof body === 'object' && typeof (body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY] === 'string'
          ? String((body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY])
          : undefined,
      seenCompletedEvent: false,
      seenDoneEvent: false,
      seenDoneMarker: false,
      seenRequiredActionEvent: false,
      seenTerminalEvent: false
    };
    let idleTimer: NodeJS.Timeout | null = null;
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

    const idleTimeoutMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_IDLE_TIMEOUT_MS', 'RCC_HTTP_SSE_IDLE_TIMEOUT_MS'],
      DEFAULT_TIMEOUTS.HTTP_SSE_IDLE_MS
    );
    let totalTimeoutMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_TIMEOUT_MS', 'RCC_HTTP_SSE_TIMEOUT_MS'],
      DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS
    );
    const overrideSseTotalTimeoutMs = Number(options?.sseTotalTimeoutMs);
    if (Number.isFinite(overrideSseTotalTimeoutMs) && overrideSseTotalTimeoutMs > 0) {
      totalTimeoutMs = Math.max(totalTimeoutMs, overrideSseTotalTimeoutMs);
    }

    const keepaliveMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_KEEPALIVE_MS', 'RCC_HTTP_SSE_KEEPALIVE_MS'],
      15_000
    );

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (totalTimer) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    };

    const endWithSseError = (code: string, message: string) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimers();
      logPipelineStage('response.sse.stream.timeout', requestLabel, { code, message });
      try {
        const payload = { type: 'error', status: 504, error: { message, code } };
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (error) {
        logResponseNonBlockingError(`response.sse.timeout.write_error_event:${requestLabel}`, error);
      }
      try {
        res.end();
      } catch (error) {
        logResponseNonBlockingError(`response.sse.timeout.end:${requestLabel}`, error);
      }
      try {
        stream.destroy?.(Object.assign(new Error(message), { code }));
      } catch (error) {
        logResponseNonBlockingError(`response.sse.timeout.destroy_stream:${requestLabel}`, error);
      }
    };

    const resetIdle = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        endWithSseError('HTTP_SSE_IDLE_TIMEOUT', `SSE idle timeout after ${idleTimeoutMs}ms`);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        endWithSseError('HTTP_SSE_TIMEOUT', `SSE timeout after ${totalTimeoutMs}ms`);
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }
    resetIdle();

    // Keep-alive: send SSE comments periodically so clients don't treat long servertool holds as a dead connection.
    // Comment frames (": ...") are ignored by SSE parsers and safe across OpenAI/Anthropic streams.
    if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (ended) {
          return;
        }
        try {
          res.write(`: keepalive\n\n`);
          resetIdle();
        } catch (error) {
          // keepalive is best-effort; stream close handlers still run.
          logResponseNonBlockingError(`response.sse.keepalive.write:${requestLabel}`, error);
        }
      }, keepaliveMs);
      keepaliveTimer.unref?.();
    }

    const cleanup = (trigger: 'close' | 'finish') => {
      if (cleanupLogged) {
        return;
      }
      cleanupLogged = true;
      clearTimers();
      try {
        stream.destroy?.();
      } catch (error) {
        logResponseNonBlockingError(`response.sse.cleanup.destroy_stream:${requestLabel}`, error);
      }
      const closeBeforeStreamEnd = trigger === 'close' && !streamEnded;
      const details = {
        events: eventCount,
        status,
        trigger,
        streamEnded,
        sawTerminalEvent: finishTracker.seenTerminalEvent,
        sawCompletedEvent: finishTracker.seenCompletedEvent,
        sawDoneEvent: finishTracker.seenDoneEvent,
        sawDoneMarker: finishTracker.seenDoneMarker,
        sawRequiredActionEvent: finishTracker.seenRequiredActionEvent,
        finishReason: finishTracker.finishReason,
        lastEventName: finishTracker.lastEventName
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
      }
      logPipelineStage('response.sse.stream.end', requestLabel, details);
      logResponseCompleted({
        status,
        mode: 'sse',
        events: eventCount,
        ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
      });
    };
    stream.on('error', (error: Error) => {
      ended = true;
      clearTimers();
      getSessionExecutionStateTracker().recordSseClientClose(requestLabel, {
        finishReason: finishTracker.finishReason,
        terminal: finishTracker.seenTerminalEvent,
        closeBeforeStreamEnd: !streamEnded
      });
      logPipelineStage('response.sse.stream.error', requestLabel, { message: error.message });
      logResponseCompleted({
        status: 500,
        mode: 'sse',
        reason: 'stream_error',
        ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
      });
      try {
        const payload = {
          type: 'error',
          status: 500,
          error: {
            message: error.message,
            code: 'sse_stream_error',
            request_id: requestLabel
          }
        };
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (writeError) {
        logResponseNonBlockingError(`response.sse.stream_error.write_error_event:${requestLabel}`, writeError);
      }
      try {
        res.end();
      } catch (endError) {
        logResponseNonBlockingError(`response.sse.stream_error.end:${requestLabel}`, endError);
      }
    });
    stream.on('data', (chunk: unknown) => {
      eventCount++;
      trackSseFinishReason(finishTracker, chunk);
      resetIdle();
    });
    stream.on('end', () => {
      ended = true;
      streamEnded = true;
      clearTimers();
      getSessionExecutionStateTracker().recordSseStreamEnd(requestLabel, {
        finishReason: finishTracker.finishReason,
        terminal: finishTracker.seenTerminalEvent
      });
      if (!completedLogged) {
        completedLogged = true;
        logStreamRequestComplete(entryEndpoint, requestLabel, status, finishTracker.finishReason, requestLogContext);
      }
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
    outboundStream.pipe(res);
    return;
  }

  applyHeaders(res, result.headers, false);
  if (body === undefined || body === null) {
    logPipelineStage('response.json.empty', requestLabel, { status });
    if (captureClientResponse) {
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
    return;
  }
  logPipelineStage('response.json.write', requestLabel, { status });
  // E1 boundary rule: internal env variables use "__*" and must never reach client payloads.
  // Preserve the SSE carrier key (it is handled above and never JSON-encoded).
  const usageNormalized = normalizeChatUsagePayload(body, {
    entryEndpoint,
    usageFallback: result.usageLogInfo?.usage
  });
  if (usageNormalized.normalized) {
    logPipelineStage('response.chat_usage.normalized', requestLabel, {
      source: usageNormalized.source
    });
  }
  const clientBody = usageNormalized.payload;
  const sanitized = stripInternalKeysDeep(clientBody, { preserveKeys: new Set(['__sse_responses']) });
  const jsonFinishReason = deriveFinishReason(clientBody);
  getSessionExecutionStateTracker().recordJsonResponseComplete(requestLabel, jsonFinishReason);
  if (captureClientResponse) {
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: requestLabel,
      entryEndpoint,
      data: { status, headers: result.headers, body: sanitized }
    }).catch((error) => {
      logResponseNonBlockingError(`writeServerSnapshot:json_payload:${requestLabel}`, error);
    });
  }
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

function shouldCaptureClientStreamSnapshots(): boolean {
  const explicit = String(
    process.env.ROUTECODEX_CAPTURE_CLIENT_STREAM_SNAPSHOTS
      ?? process.env.RCC_CAPTURE_CLIENT_STREAM_SNAPSHOTS
      ?? ''
  ).trim().toLowerCase();
  if (explicit === '1' || explicit === 'true') {
    return true;
  }
  if (explicit === '0' || explicit === 'false') {
    return false;
  }
  const flag = String(process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') {
    return false;
  }
  if (flag === '0' || flag === 'false') {
    return false;
  }
  return false;
}

function resolveClientStreamSnapshotMaxBytes(): number {
  const raw = String(
    process.env.ROUTECODEX_CLIENT_STREAM_SNAPSHOT_MAX_BYTES ||
      process.env.RCC_CLIENT_STREAM_SNAPSHOT_MAX_BYTES ||
      '2000000'
  ).trim();
  const parsed = Number(raw);
  if (!raw) {
    return 2_000_000;
  }
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return 2_000_000;
}

function maybeAttachClientSseSnapshotStream(
  stream: NodeJS.ReadableStream,
  options: {
    requestId: string;
    entryEndpoint?: string;
    status: number;
    headers?: Record<string, string>;
  }
): NodeJS.ReadableStream {
  if (!shouldCaptureClientStreamSnapshots()) {
    return stream;
  }
  const maxBytes = resolveClientStreamSnapshotMaxBytes();
  if (maxBytes <= 0) {
    return stream;
  }

  const tee = new PassThrough();
  const capture = new PassThrough();

  stream.pipe(tee);
  stream.pipe(capture);

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let flushed = false;

  const toBuffer = (chunk: unknown): Buffer => {
    if (Buffer.isBuffer(chunk)) {
      return chunk;
    }
    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk);
    }
    if (typeof chunk === 'string') {
      return Buffer.from(chunk, 'utf8');
    }
    if (chunk === undefined || chunk === null) {
      return Buffer.alloc(0);
    }
    return Buffer.from(String(chunk), 'utf8');
  };

  const flushSnapshot = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      stream.unpipe(capture);
    } catch (error) {
      logResponseNonBlockingError(`stream.unpipe:${options.requestId}`, error);
    }
    capture.removeAllListeners();
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    const payload: Record<string, unknown> = {
      mode: 'sse',
      status: options.status,
      headers: options.headers,
      raw: raw || undefined,
      truncated: truncated || undefined,
      maxBytes
    };
    if (error) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      data: payload
    }).catch((error) => {
      logResponseNonBlockingError(`writeServerSnapshot:sse_payload:${options.requestId}`, error);
    });
  };

  capture.on('data', (chunk: unknown) => {
    const buf = toBuffer(chunk);
    if (buf.length === 0) {
      return;
    }
    if (truncated || size >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - size;
    if (buf.length <= remaining) {
      chunks.push(buf);
      size += buf.length;
      return;
    }
    if (remaining > 0) {
      chunks.push(buf.slice(0, remaining));
      size += remaining;
    }
    truncated = true;
  });

  capture.on('end', () => flushSnapshot());
  capture.on('close', () => flushSnapshot());
  capture.on('error', (error) => flushSnapshot(error));
  stream.on('error', (error) => {
    flushSnapshot(error);
    try {
      tee.destroy(error as Error);
    } catch (destroyError) {
      logResponseNonBlockingError(`response.sse.snapshot.destroy_tee:${options.requestId}`, destroyError);
      tee.destroy();
    }
  });
  tee.on('error', (error) => flushSnapshot(error));

  return tee;
}
