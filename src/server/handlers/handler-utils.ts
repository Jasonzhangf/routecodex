import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import chalk from 'chalk';
import type { HandlerContext } from './types.js';
import { mapErrorToHttp } from '../utils/http-error-mapper.js';
import { buildInfo } from '../../build-info.js';
import type { RouteErrorPayload } from '../../error-handling/route-error-hub.js';
import { reportRouteError } from '../../error-handling/route-error-hub.js';
// import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { formatErrorForConsole } from '../../utils/log-helpers.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import {
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../utils/request-id-manager.js';
import {
  isAnalysisModeEnabled
} from './handler-response-utils.js';
export { hasSsePayload, sendPipelineResponse, type SsePayloadShape } from './handler-response-utils.js';

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

type RequestLogMeta = Record<string, unknown> | undefined;

const SHOULD_LOG_HTTP_EVENTS = buildInfo.mode !== 'release'
  || process.env.ROUTECODEX_HTTP_LOG_VERBOSE === '1';

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function shouldLogHttpErrorMeta(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_HTTP_ERROR_META_LOG
      ?? process.env.RCC_HTTP_ERROR_META_LOG
      ?? process.env.ROUTECODEX_ERROR_VERBOSE
      ?? process.env.RCC_ERROR_VERBOSE,
    false
  );
}

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

export function logRequestStart(endpoint: string, requestId: string, meta?: RequestLogMeta): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  void endpoint;
  void requestId;
  void meta;
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
  if (rawMeta && shouldLogHttpErrorMeta()) {
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
