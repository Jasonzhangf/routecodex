import { Readable, PassThrough } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import { logPipelineStage } from '../utils/stage-logger.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';

const BLOCKED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);

interface DispatchOptions {
  forceSSE?: boolean;
  entryEndpoint?: string;
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

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
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
