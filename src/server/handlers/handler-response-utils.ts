import { Readable } from 'node:stream';
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
  finishReason?: string;
  seenTerminalEvent: boolean;
};

type SseTerminalWatch = {
  sawTerminalChunk: boolean;
  terminalSource?: string;
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

function cleanupAbandonedResponsesConversation(
  requestLabel: string,
  options: {
    entryEndpoint?: string;
    closeBeforeStreamEnd: boolean;
  }
): void {
  if (!options.closeBeforeStreamEnd || options.entryEndpoint !== '/v1/responses') {
    return;
  }
  try {
    const store = (globalThis as Record<string, unknown>)['__rccResponsesConversationStore'] as
      | { clearRequest?: (requestId?: string) => void }
      | undefined;
    store?.clearRequest?.(requestLabel);
  } catch (error) {
    logResponseNonBlockingError(`response.sse.client_close.clear_responses_conversation:${requestLabel}`, error);
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
    finishTracker.seenTerminalEvent = true;
    finishTracker.finishReason ||= 'stop';
    terminalWatch.sawTerminalChunk = true;
    terminalWatch.terminalSource = terminalWatch.terminalSource ?? '[DONE]';
  }

  if (!text.includes('response.completed') && !text.includes('response.done')) {
    return;
  }

  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block || (!block.includes('response.completed') && !block.includes('response.done'))) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find((name) => name === 'response.completed' || name === 'response.done');
    if (!eventName) {
      continue;
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
    finishTracker.seenTerminalEvent = true;
    finishTracker.finishReason = derived ?? 'stop';
    terminalWatch.sawTerminalChunk = true;
    terminalWatch.terminalSource = eventName;
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
        requestStartedAtMs: usageLogInfo.requestStartedAtMs
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
    const structuredErrorPayload = extractStructuredSseErrorPayload(body, requestLabel, status);
    logResponseCompleted({
      status: 200,
      mode: 'sse',
      reason: structuredErrorPayload ? 'structured_error_passthrough' : 'missing_stream',
      bridgeStatus: structuredErrorPayload ? status : 502
    });
    if (captureClientResponse) {
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

    let ended = false;
    let completedLogged = false;
    let cleanupLogged = false;
    let streamEnded = false;
    const finishTracker: SseFinishReasonTracker = {
      finishReason:
        body && typeof body === 'object' && typeof (body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY] === 'string'
          ? String((body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY])
          : undefined,
      seenTerminalEvent:
        body && typeof body === 'object' && typeof (body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY] === 'string',
    };
    let totalTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let terminalGraceTimer: NodeJS.Timeout | null = null;
    const terminalWatch: SseTerminalWatch = {
      sawTerminalChunk: false,
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
      15_000
    );

    const clearTimers = () => {
      if (totalTimer) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (terminalGraceTimer) {
        clearTimeout(terminalGraceTimer);
        terminalGraceTimer = null;
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

    if (typeof totalTimeoutMs === 'number' && Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        endWithSseError('HTTP_SSE_TIMEOUT', `SSE timeout after ${totalTimeoutMs}ms`);
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }

    // Keep-alive: send SSE comments periodically so clients don't treat long servertool holds as a dead connection.
    // Comment frames (": ...") are ignored by SSE parsers and safe across OpenAI/Anthropic streams.
    if (Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (ended) {
          return;
        }
        try {
          res.write(`: keepalive\n\n`);
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
        cleanupAbandonedResponsesConversation(requestLabel, {
          entryEndpoint,
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
        ...(finishTracker.finishReason ? { finishReason: finishTracker.finishReason } : {})
      });
    };
    stream.on('data', (chunk: unknown) => {
      updateSseTerminalTrackerFromChunk(chunk, finishTracker, terminalWatch);
      if (!terminalWatch.sawTerminalChunk || ended || streamEnded || terminalGraceTimer) {
        return;
      }
      terminalGraceTimer = setTimeout(() => {
        if (ended || streamEnded || !finishTracker.seenTerminalEvent) {
          return;
        }
        ended = true;
        streamEnded = true;
        clearTimers();
        getSessionExecutionStateTracker().recordSseStreamEnd(requestLabel, {
          finishReason: finishTracker.finishReason,
          terminal: true
        });
        if (!completedLogged) {
          completedLogged = true;
          logStreamRequestComplete(entryEndpoint, requestLabel, status, finishTracker.finishReason, requestLogContext);
        }
        try {
          stream.destroy?.();
        } catch (destroyError) {
          logResponseNonBlockingError(`response.sse.terminal.destroy_stream:${requestLabel}`, destroyError);
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch (endError) {
            logResponseNonBlockingError(`response.sse.terminal.end:${requestLabel}`, endError);
          }
        }
      }, 250);
      terminalGraceTimer.unref?.();
    });
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
    stream.on('end', () => {
      ended = true;
      streamEnded = true;
      clearTimers();
      const resolvedStreamFinishReason =
        finishTracker.finishReason
        || (typeof result.usageLogInfo?.finishReason === 'string' && result.usageLogInfo.finishReason.trim()
          ? result.usageLogInfo.finishReason.trim()
          : undefined);
      finishTracker.finishReason = resolvedStreamFinishReason;
      finishTracker.seenTerminalEvent = Boolean(resolvedStreamFinishReason);
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
      if (!completedLogged) {
        completedLogged = true;
        logStreamRequestComplete(entryEndpoint, requestLabel, status, resolvedStreamFinishReason, requestLogContext);
      }
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch (endError) {
          logResponseNonBlockingError(`response.sse.stream.end:${requestLabel}`, endError);
        }
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
    outboundStream.pipe(res, { end: false });
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

  let flushed = false;

  const flushSnapshot = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    } catch (error) {
      logResponseNonBlockingError(`stream.removeListener:${options.requestId}`, error);
    }
    const payload: Record<string, unknown> = {
      mode: 'sse',
      status: options.status,
      headers: options.headers
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

  const onEnd = () => flushSnapshot();
  const onClose = () => flushSnapshot();
  const onError = (error: unknown) => flushSnapshot(error);

  stream.on('end', onEnd);
  stream.on('close', onClose);
  stream.on('error', onError);

  return stream;
}
