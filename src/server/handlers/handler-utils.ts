import { Readable, PassThrough } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import chalk from 'chalk';
import type { HandlerContext, PipelineExecutionResult } from './types.js';
import { mapErrorToHttp } from '../utils/http-error-mapper.js';
import { logPipelineStage } from '../utils/stage-logger.js';
import { buildInfo } from '../../build-info.js';
import type { RouteErrorPayload } from '../../error-handling/route-error-hub.js';
import { reportRouteError } from '../../error-handling/route-error-hub.js';
// import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { formatErrorForConsole } from '../../utils/log-helpers.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import {
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../utils/request-id-manager.js';
const BLOCKED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);
const CLIENT_HEADER_DENYLIST = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-routecodex-api-key',
  'x-routecodex-apikey',
  'api-key',
  'apikey',
  'upgrade',
  'te'
]);

interface DispatchOptions {
  forceSSE?: boolean;
  entryEndpoint?: string;
}

type RequestLogMeta = Record<string, unknown> | undefined;

export interface SsePayloadShape {
  __sse_responses?: unknown;
}

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

export function hasSsePayload(body: unknown): body is SsePayloadShape {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

const SHOULD_LOG_HTTP_EVENTS = buildInfo.mode !== 'release'
  || process.env.ROUTECODEX_HTTP_LOG_VERBOSE === '1';

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
}

function isAnalysisModeEnabled(): boolean {
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

export function nextRequestIdentifiers(
  candidate?: unknown,
  meta?: { entryEndpoint?: string; providerId?: string; model?: string }
): { clientRequestId: string; providerRequestId: string } {
  return generateRequestIdentifiers(candidate, meta);
}

export function nextRequestId(
  candidate?: unknown,
  meta?: { entryEndpoint?: string; providerId?: string; model?: string }
): string {
  return generateRequestIdentifiers(candidate, meta).providerRequestId;
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
  const captureClientResponse = isAnalysisModeEnabled();

  if (forceSSE && !expectsStream) {
    logPipelineStage('response.sse.missing', requestLabel, { status });
    if (captureClientResponse) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: requestLabel,
        entryEndpoint,
        data: { status: 502, error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } }
      }).catch(() => {});
    }
    res.status(502).json({ error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } });
    return;
  }

  logPipelineStage('response.dispatch.start', requestLabel, { status, stream: expectsStream, forced: forceSSE });

  if (expectsStream) {
    const streamSource = body.__sse_responses;
    const stream = toNodeReadable(streamSource);
    if (!stream) {
      logPipelineStage('response.sse.missing', requestLabel, {});
      if (captureClientResponse) {
        void writeServerSnapshot({
          phase: 'client-response.error',
          requestId: requestLabel,
          entryEndpoint,
          data: { status: 502, error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } }
        }).catch(() => {});
      }
      res.status(502).json({ error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } });
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

    let eventCount = 0;
    let ended = false;
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
    const totalTimeoutMs = readTimeoutMs(
      ['ROUTECODEX_HTTP_SSE_TIMEOUT_MS', 'RCC_HTTP_SSE_TIMEOUT_MS'],
      DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS
    );

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
      } catch {
        /* ignore */
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
      try {
        stream.destroy?.(Object.assign(new Error(message), { code }));
      } catch {
        /* ignore */
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
        } catch {
          // ignore write failures; close handler will clean up
        }
      }, keepaliveMs);
      keepaliveTimer.unref?.();
    }

    const cleanup = () => {
      clearTimers();
      try {
        stream.destroy?.();
      } catch {
        /* ignore cleanup errors */
      }
      logPipelineStage('response.sse.stream.end', requestLabel, { events: eventCount, status });
    };
    stream.on('error', (error: Error) => {
      ended = true;
      clearTimers();
      logPipelineStage('response.sse.stream.error', requestLabel, { message: error.message });
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      } catch {
        /* ignore write errors */
      }
      try {
        res.end();
      } catch {
        /* ignore end errors */
      }
    });
    stream.on('data', () => {
      eventCount++;
      resetIdle();
    });
    res.on('close', cleanup);
    res.on('finish', cleanup);
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
      }).catch(() => {});
    }
    res.status(status).end();
    logPipelineStage('response.json.completed', requestLabel, { status });
    return;
  }
  logPipelineStage('response.json.write', requestLabel, { status });
  // E1 boundary rule: internal env variables use "__*" and must never reach client payloads.
  // Preserve the SSE carrier key (it is handled above and never JSON-encoded).
  const sanitized = stripInternalKeysDeep(body, { preserveKeys: new Set(['__sse_responses']) });
  if (captureClientResponse) {
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: requestLabel,
      entryEndpoint,
      data: { status, headers: result.headers, body: sanitized }
    }).catch(() => {});
  }
  res.status(status).json(sanitized);
  logPipelineStage('response.json.completed', requestLabel, { status });
}

export function logRequestStart(endpoint: string, requestId: string, meta?: RequestLogMeta): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  const displayId = typeof meta?.clientRequestId === 'string' && meta.clientRequestId.trim()
    ? meta.clientRequestId.trim()
    : requestId;
  const suffix = formatMeta(meta);
  console.log(`➡️  [${endpoint}] request ${formatRequestId(displayId)}${suffix}`);
}

export function logRequestComplete(endpoint: string, requestId: string, status: number): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  console.log(`✅ [${endpoint}] request ${formatRequestId(requestId)} completed (status=${status})`);
}

export function logRequestError(endpoint: string, requestId: string, error: unknown): void {
  const resolvedId = formatRequestId(requestId);
  const formatted = formatErrorForConsole(error);
  const rawMeta = extractRawErrorMeta(error);
  const summary = rawMeta?.rawErrorSnippet ?? formatted.text;
  const chalkError = typeof chalk?.redBright === 'function' ? chalk.redBright : (value: string) => value;
  console.error(chalkError(`❌ [${endpoint}] request ${resolvedId} failed: ${summary}`));
  if (rawMeta) {
    const payload = {
      requestId: resolvedId,
      endpoint,
      rawError: rawMeta.rawError,
      rawErrorSnippet: rawMeta.rawErrorSnippet ?? summary
    };
    console.error(chalkError(`[http.error.meta] ${JSON.stringify(payload)}`));
  }
}

function extractRawErrorMeta(error: unknown): { rawError?: string; rawErrorSnippet?: string } | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const bag = error as Record<string, unknown>;
  const rawError = typeof bag.rawError === 'string' ? bag.rawError : undefined;
  const rawErrorSnippet = typeof bag.rawErrorSnippet === 'string' ? bag.rawErrorSnippet : undefined;
  if (!rawError && !rawErrorSnippet) {
    return null;
  }
  return { rawError, rawErrorSnippet };
}

export async function respondWithPipelineError(
  res: Response,
  ctx: HandlerContext,
  error: unknown,
  entryEndpoint: string,
  requestId: string,
  options?: { forceSse?: boolean }
): Promise<void> {
  const effectiveRequestId = formatRequestId(requestId);
  const normalizedError = normalizeError(error, effectiveRequestId, entryEndpoint);
  const routePayload: RouteErrorPayload = {
    code: typeof (normalizedError as Record<string, unknown>).code === 'string'
      ? String((normalizedError as Record<string, unknown>).code)
      : 'HTTP_HANDLER_ERROR',
    message: normalizedError.message,
    source: `http-handler.${entryEndpoint}`,
    scope: 'http',
    severity: 'medium',
    requestId: effectiveRequestId,
    endpoint: entryEndpoint,
    providerKey: (normalizedError as Record<string, unknown>).providerKey as string | undefined,
    providerType: (normalizedError as Record<string, unknown>).providerType as string | undefined,
    routeName: (normalizedError as Record<string, unknown>).routeName as string | undefined,
    details: {
      ...(normalizedError as Record<string, unknown>),
      endpoint: entryEndpoint
    },
    originalError: normalizedError
  };
  let mapped = mapErrorToHttp(normalizedError);
  try {
    const { http } = await reportRouteError(routePayload, { includeHttpResult: true });
    if (http) {
      mapped = http;
    }
  } catch {
    /* ignore hub failures */
  }
  if (effectiveRequestId && mapped.body?.error && !mapped.body.error.request_id) {
    mapped.body.error.request_id = effectiveRequestId;
  }
  if (options?.forceSse) {
    // For streaming clients, return an SSE error event so the client can surface the failure.
    // Use the mapped HTTP status so clients can fail fast; embed the status in the event payload as well.
    const payload = mapped.body?.error
      ? { type: 'error', status: mapped.status, error: mapped.body.error }
      : { type: 'error', status: mapped.status, error: mapped.body };
    res.status(mapped.status);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    try {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // ignore stream write errors
    }
    try {
      res.end();
    } catch {
      // ignore end errors
    }
    if (isAnalysisModeEnabled()) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: effectiveRequestId,
        entryEndpoint,
        data: { mode: 'sse', status: mapped.status, payload }
      }).catch(() => {});
    }
    return;
  }
  if (isAnalysisModeEnabled()) {
    void writeServerSnapshot({
      phase: 'client-response.error',
      requestId: effectiveRequestId,
      entryEndpoint,
      data: { mode: 'json', status: mapped.status, body: mapped.body }
    }).catch(() => {});
  }
  res.status(mapped.status).json(mapped.body);
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

type PipeCapable = { pipe?: unknown };
type WebReadable = { getReader?: () => unknown };
type AsyncIterableLike = { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

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
    } catch {
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
  if (!isAnalysisModeEnabled()) {
    return false;
  }
  const flag = String(process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') {
    return true;
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
    } catch {
      /* ignore */
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
    }).catch(() => {});
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
    } catch {
      tee.destroy();
    }
  });
  tee.on('error', (error) => flushSnapshot(error));

  return tee;
}

export function captureClientHeaders(headers: IncomingHttpHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (CLIENT_HEADER_DENYLIST.has(normalized)) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value[0]) {
        result[key] = String(value[0]);
      }
    } else if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function normalizeError(error: unknown, requestId: string, endpoint: string): Error & Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const enriched = err as Error & Record<string, unknown>;
  if (!enriched.requestId) {
    enriched.requestId = requestId;
  }
  if (!enriched.endpoint) {
    enriched.endpoint = endpoint;
  }
  return enriched;
}

function formatMeta(meta?: RequestLogMeta): string {
  if (!meta || typeof meta !== 'object') {
    return '';
  }
  const entries = Object.entries(meta)
    .filter(([_, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  return entries.length ? ` (${entries.join(', ')})` : '';
}
