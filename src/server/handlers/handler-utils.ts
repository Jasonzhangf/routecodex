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
import { colorizeRequestLog, formatHighlightedFinishReasonLabel } from '../utils/request-log-color.js';
import { deriveFinishReason } from '../utils/finish-reason.js';
import { isSnapshotsEnabled, writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { formatRequestTimingSummary } from '../utils/stage-logger.js';
import {
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../utils/request-id-manager.js';
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

function logHandlerNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[handler-utils] ${operation} failed (non-blocking): ${reason}`);
}

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

function parseStatusCodeCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseFieldFromText(summary: string): {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
} {
  const statusMatch = summary.match(/\b(?:HTTP\s+)?(\d{3})\b/i);
  const statusCode = statusMatch
    ? Number.parseInt(statusMatch[1], 10)
    : undefined;
  const codeMatch =
    summary.match(/"code"\s*:\s*"([^"]+)"/i)?.[1]
    ?? summary.match(/\bcode[=:]\s*([A-Za-z0-9_.-]+)/i)?.[1];
  const upstreamCodeMatch =
    summary.match(/"upstream(?:_code|Code)"\s*:\s*"([^"]+)"/i)?.[1]
    ?? summary.match(/\bupstream(?:_code|Code)[=:]\s*([A-Za-z0-9_.-]+)/i)?.[1];
  return {
    ...(typeof statusCode === 'number' && Number.isFinite(statusCode) ? { statusCode } : {}),
    ...(codeMatch ? { errorCode: codeMatch } : {}),
    ...(upstreamCodeMatch ? { upstreamCode: upstreamCodeMatch } : {})
  };
}

function extractErrorLogFields(error: unknown, summary: string): {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
} {
  if (!error || typeof error !== 'object') {
    return parseFieldFromText(summary);
  }
  const bag = error as Record<string, unknown>;
  const details =
    bag.details && typeof bag.details === 'object' && !Array.isArray(bag.details)
      ? (bag.details as Record<string, unknown>)
      : undefined;
  const response =
    bag.response && typeof bag.response === 'object' && !Array.isArray(bag.response)
      ? (bag.response as Record<string, unknown>)
      : undefined;
  const responseData =
    response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : undefined;
  const responseError =
    responseData?.error && typeof responseData.error === 'object' && !Array.isArray(responseData.error)
      ? (responseData.error as Record<string, unknown>)
      : undefined;

  const statusCode =
    parseStatusCodeCandidate(bag.statusCode)
    ?? parseStatusCodeCandidate(bag.status)
    ?? parseStatusCodeCandidate(response?.status)
    ?? parseStatusCodeCandidate(responseData?.status)
    ?? parseStatusCodeCandidate(responseError?.status);
  const errorCode =
    readTrimmedString(bag.code)
    ?? readTrimmedString(bag.errorCode)
    ?? readTrimmedString(details?.code)
    ?? readTrimmedString(responseError?.code)
    ?? (typeof bag.code === 'number' ? String(bag.code) : undefined)
    ?? (typeof bag.errorCode === 'number' ? String(bag.errorCode) : undefined)
    ?? (typeof details?.code === 'number' ? String(details.code) : undefined)
    ?? (typeof responseError?.code === 'number' ? String(responseError.code) : undefined);
  const upstreamCode =
    readTrimmedString(bag.upstreamCode)
    ?? readTrimmedString(details?.upstreamCode)
    ?? readTrimmedString(details?.upstream_code)
    ?? readTrimmedString(responseError?.upstreamCode)
    ?? readTrimmedString(responseError?.upstream_code)
    ?? (typeof bag.upstreamCode === 'number' ? String(bag.upstreamCode) : undefined)
    ?? (typeof details?.upstreamCode === 'number' ? String(details.upstreamCode) : undefined)
    ?? (typeof details?.upstream_code === 'number' ? String(details.upstream_code) : undefined)
    ?? (typeof responseError?.upstreamCode === 'number' ? String(responseError.upstreamCode) : undefined)
    ?? (typeof responseError?.upstream_code === 'number' ? String(responseError.upstream_code) : undefined);

  const fromText = parseFieldFromText(summary);
  return {
    ...(typeof statusCode === 'number'
      ? { statusCode }
      : (typeof fromText.statusCode === 'number' ? { statusCode: fromText.statusCode } : {})),
    ...(errorCode ? { errorCode } : (fromText.errorCode ? { errorCode: fromText.errorCode } : {})),
    ...(upstreamCode ? { upstreamCode } : (fromText.upstreamCode ? { upstreamCode: fromText.upstreamCode } : {}))
  };
}

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
}

function formatTimestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
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
  // HTTP request start logs are intentionally suppressed to reduce noise.
  return;
}

export function logRequestComplete(
  endpoint: string,
  requestId: string,
  status: number,
  body?: unknown,
  options?: { preserveTimingForUsage?: boolean }
): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  const resolvedId = formatRequestId(requestId);
  const timestamp = formatTimestamp();
  const finishReason = deriveFinishReason(body);
  const finishReasonLabel = formatHighlightedFinishReasonLabel(finishReason);
  const timingSuffix = options?.preserveTimingForUsage
    ? ''
    : formatRequestTimingSummary(resolvedId, { terminal: true });
  const line = `✅ [${endpoint}] ${timestamp} request ${resolvedId} completed (status=${status}${finishReasonLabel})${timingSuffix}`;
  console.log(colorizeRequestLog(line, resolvedId));
}


export function logRequestError(endpoint: string, requestId: string, error: unknown): void {
  const resolvedId = formatRequestId(requestId);
  const formatted = formatErrorForConsole(error);
  const rawMeta = extractRawErrorMeta(error);
  const summary = rawMeta?.rawErrorSnippet ?? formatted.text;
  const fields = extractErrorLogFields(error, summary);
  const fieldSuffix = [
    typeof fields.statusCode === 'number' ? `status=${fields.statusCode}` : undefined,
    fields.errorCode ? `code=${fields.errorCode}` : undefined,
    fields.upstreamCode ? `upstreamCode=${fields.upstreamCode}` : undefined
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ');
  const timestamp = formatTimestamp();
  const timingSuffix = formatRequestTimingSummary(resolvedId, { terminal: true });
  const line = `❌ [${endpoint}] ${timestamp} request ${resolvedId} failed: ${summary}${fieldSuffix ? ` (${fieldSuffix})` : ''}${timingSuffix}`;
  console.error(colorizeRequestLog(line, resolvedId) || line);
  if (rawMeta && shouldLogHttpErrorMeta()) {
    const payload = {
      requestId: resolvedId,
      endpoint,
      rawError: rawMeta.rawError,
      rawErrorSnippet: rawMeta.rawErrorSnippet ?? summary
    };
    const metaLine = `[http.error.meta] ${JSON.stringify(payload)}`;
    console.error(colorizeRequestLog(metaLine, resolvedId) || metaLine);
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
  } catch (error) {
    logHandlerNonBlockingError(`reportRouteError:${effectiveRequestId}`, error);
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
    } catch (error) {
      logHandlerNonBlockingError(`sseErrorWrite:${effectiveRequestId}`, error);
    }
    try {
      res.end();
    } catch (error) {
      logHandlerNonBlockingError(`sseErrorEnd:${effectiveRequestId}`, error);
    }
    if (isSnapshotsEnabled()) {
      void writeServerSnapshot({
        phase: 'client-response.error',
        requestId: effectiveRequestId,
        entryEndpoint,
        data: { mode: 'sse', status: mapped.status, payload }
      }).catch((error) => {
        logHandlerNonBlockingError(`writeServerSnapshot:sse_error:${effectiveRequestId}`, error);
      });
    }
    return;
  }
  if (isSnapshotsEnabled()) {
    void writeServerSnapshot({
      phase: 'client-response.error',
      requestId: effectiveRequestId,
      entryEndpoint,
      data: { mode: 'json', status: mapped.status, body: mapped.body }
    }).catch((error) => {
      logHandlerNonBlockingError(`writeServerSnapshot:json_error:${effectiveRequestId}`, error);
    });
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
