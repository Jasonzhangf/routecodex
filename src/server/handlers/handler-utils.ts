import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import type { HandlerContext, PipelineExecutionResult } from './types.js';
import { mapErrorToHttp } from '../utils/http-error-mapper.js';
import { logPipelineStage } from '../utils/stage-logger.js';
import { buildInfo } from '../../build-info.js';
import type { RouteErrorPayload } from '../../error-handling/route-error-hub.js';
import { reportRouteError } from '../../error-handling/route-error-hub.js';
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
  'upgrade',
  'te'
]);

interface DispatchOptions {
  forceSSE?: boolean;
}

type RequestLogMeta = Record<string, unknown> | undefined;

interface SsePayloadShape {
  __sse_responses?: unknown;
}

type FlushableResponse = Response & {
  flushHeaders?: () => void;
  flush?: () => void;
};

function hasSsePayload(body: unknown): body is SsePayloadShape {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

const SHOULD_LOG_HTTP_EVENTS = buildInfo.mode !== 'release'
  || process.env.ROUTECODEX_HTTP_LOG_VERBOSE === '1';

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
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

  if (forceSSE && !expectsStream) {
    logPipelineStage('response.sse.missing', requestLabel, { status });
    res.status(502).json({ error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } });
    return;
  }

  logPipelineStage('response.dispatch.start', requestLabel, { status, stream: expectsStream, forced: forceSSE });

  if (expectsStream) {
    const streamSource = body.__sse_responses;
    const stream = toNodeReadable(streamSource);
    if (!stream) {
      logPipelineStage('response.sse.missing', requestLabel, {});
      res.status(502).json({ error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' } });
      return;
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
    });
    res.on('close', cleanup);
    res.on('finish', cleanup);
    stream.pipe(res);
    return;
  }

  applyHeaders(res, result.headers, false);
  if (body === undefined || body === null) {
    logPipelineStage('response.json.empty', requestLabel, { status });
    res.status(status).end();
    logPipelineStage('response.json.completed', requestLabel, { status });
    return;
  }
  logPipelineStage('response.json.write', requestLabel, { status });
  res.status(status).json(body);
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
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  console.error(`❌ [${endpoint}] request ${resolvedId} failed: ${message}`);
}

export async function respondWithPipelineError(
  res: Response,
  _ctx: HandlerContext,
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
    // Use 200 to keep SSE parsers happy; embed the actual status in the event payload.
    const payload = mapped.body?.error
      ? { type: 'error', status: mapped.status, error: mapped.body.error }
      : { type: 'error', status: mapped.status, error: mapped.body };
    res.status(200);
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
    return;
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
