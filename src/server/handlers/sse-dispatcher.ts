import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import { logPipelineStage } from '../utils/stage-logger.js';
import { applyResponseHeaders } from './response-headers.js';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSY_VALUES = new Set(['0', 'false', 'no', 'off']);
const SSE_STAGE_LOG_ENABLED = computeSseStageLoggingFlag();

export interface SsePayloadShape {
  __sse_responses?: unknown;
}

export interface DispatchSseOptions {
  res: Response;
  headers?: Record<string, string>;
  status: number;
  requestLabel: string;
  streamSource: unknown;
  forceSse?: boolean;
}

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

type PipeCapable = { pipe?: unknown };
type WebReadable = { getReader?: () => unknown };
type AsyncIterableLike = { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

export function hasSsePayload(body: unknown): body is SsePayloadShape {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

export function dispatchSseStream(options: DispatchSseOptions): boolean {
  const { res, headers, status, requestLabel, streamSource } = options;
  const stream = toNodeReadable(streamSource);
  if (!stream) {
    logPipelineStage('response.sse.missing', requestLabel, { status });
    res.status(502).json({ error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } });
    return false;
  }
  applyResponseHeaders(res, headers, true);
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

  const cleanup = () => {
    try {
      stream.destroy?.();
    } catch {
      /* ignore cleanup errors */
    }
    logPipelineStage('response.sse.stream.end', requestLabel, { events: eventCount, status });
  };

  stream.on('error', (error: Error) => {
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

  stream.on('data', (chunk: unknown) => {
    eventCount++;
    if (eventCount <= 3 && SSE_STAGE_LOG_ENABLED) {
      try {
        const text = extractPreviewText(chunk);
        if (!text) {
          return;
        }
        const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        logPipelineStage('response.sse.preview', requestLabel, {
          event: eventCount,
          preview: trimmed
        });
      } catch {
        /* ignore preview errors */
      }
    }

    // Direct write without buffering (for testing)
    try {
      res.write(chunk);
    } catch (error) {
      /* ignore write errors */
    }
  });

  stream.on('end', () => {
    // End response directly (UTF-8 buffer disabled for testing)
    try {
      res.end();
    } catch {
      /* ignore end errors */
    }
  });

  res.on('close', cleanup);
  res.on('finish', cleanup);

  // Note: We handle writing manually via the data event listener above,
  // so we don't use stream.pipe(res) anymore
  return true;
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

function extractPreviewText(chunk: unknown): string | null {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (typeof chunk === 'object' && chunk !== null) {
    if (Buffer.isBuffer(chunk)) {
      return chunk.toString('utf8');
    }
    const candidate = (chunk as { toString?: () => string }).toString?.();
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return null;
}

function computeSseStageLoggingFlag(): boolean {
  const raw = String(process.env.ROUTECODEX_SSE_STAGE_LOG || '').trim().toLowerCase();
  if (TRUTHY_VALUES.has(raw)) {
    return true;
  }
  if (FALSY_VALUES.has(raw)) {
    return false;
  }
  return false;
}
