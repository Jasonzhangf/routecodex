import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import type { HandlerContext } from './types.js';
import { mapErrorToHttp, mapErrorToPublicLogSummary, type HttpErrorPayload } from '../utils/http-error-mapper.js';
import type { RouteErrorPayload } from '../../error-handling/route-error-hub.js';
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
import { assertClientResponseHasNoInternalCarriers as assertClientErrorBodyHasNoInternalCarriers } from './handler-response-utils.js';

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

const SHOULD_LOG_HTTP_EVENTS = process.env.ROUTECODEX_HTTP_LOG_DISABLE !== '1'
  && process.env.RCC_HTTP_LOG_DISABLE !== '1';
const RAW_REQUEST_PREVIEW_MAX_ARRAY_ITEMS = 32;

function logHandlerNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[handler-utils] ${operation} failed (non-blocking): ${reason}`);
}

function resolveBoolFromEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
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

function buildPublicRawErrorMeta(args: {
  rawMeta: { rawError?: string; rawErrorSnippet?: string };
  fields: { statusCode?: number; errorCode?: string; upstreamCode?: string };
  publicSummary: string;
}): { rawError?: string; rawErrorSnippet?: string } {
  const errorNode: Record<string, unknown> = {};
  if (args.fields.errorCode) {
    errorNode.code = args.fields.errorCode;
  }
  if (typeof args.fields.statusCode === 'number') {
    errorNode.status = args.fields.statusCode;
  }
  if (args.fields.upstreamCode) {
    errorNode.upstream_code = args.fields.upstreamCode;
  }
  if (!Object.keys(errorNode).length) {
    errorNode.message = args.publicSummary;
  }
  const sanitized = JSON.stringify({ error: errorNode });
  return {
    ...(args.rawMeta.rawError ? { rawError: sanitized } : {}),
    rawErrorSnippet: sanitized
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
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  const resolvedId = formatRequestId(requestId);
  const timestamp = formatTimestamp();
  const suffix = meta && typeof meta === 'object'
    ? (() => {
        const bag = meta as Record<string, unknown>;
        const fields = [
          typeof bag.inboundStream === 'boolean' ? `stream=${bag.inboundStream}` : undefined,
          typeof bag.clientAcceptsSse === 'boolean' ? `acceptsSse=${bag.clientAcceptsSse}` : undefined,
          typeof bag.timeoutMs === 'number' ? `timeoutMs=${bag.timeoutMs}` : undefined,
          typeof bag.videoRequest === 'boolean' ? `video=${bag.videoRequest}` : undefined,
          typeof bag.type === 'string' && bag.type.trim() ? `type=${bag.type}` : undefined
        ]
          .filter((item): item is string => Boolean(item))
          .join(' ');
        return fields ? ` (${fields})` : '';
      })()
    : '';
  const line = `▶ [${endpoint}] ${timestamp} request ${resolvedId} started${suffix}`;
  console.warn(colorizeRequestLog(line, resolvedId));
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
  console.warn(colorizeRequestLog(line, resolvedId));
}


export function logRequestError(endpoint: string, requestId: string, error: unknown): void {
  const resolvedId = formatRequestId(requestId);
  const formatted = formatErrorForConsole(error);
  const rawMeta = extractRawErrorMeta(error);
  const rawSnippet = rawMeta?.rawErrorSnippet;
  const responseDataShell = extractCodeOnlyResponseDataShell(error);
  const summaryFromRaw = shouldUseRawSnippetAsSummary(rawSnippet, formatted.text)
    ? String(rawSnippet)
    : formatted.text;
  const summary =
    responseDataShell && isCodeOnlyShellError(responseDataShell) && formatted.text.trim()
      ? formatted.text
      : summaryFromRaw;
  const publicSummary = resolvePrimaryErrorLogSummary(error, summary);
  const fields = extractErrorLogFields(error, publicSummary);
  const fieldSuffix = [
    typeof fields.statusCode === 'number' ? `status=${fields.statusCode}` : undefined,
    fields.errorCode ? `code=${fields.errorCode}` : undefined,
    fields.upstreamCode ? `upstreamCode=${fields.upstreamCode}` : undefined
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ');
  const timestamp = formatTimestamp();
  const timingSuffix = formatRequestTimingSummary(resolvedId, { terminal: true });
  const line = `❌ [${endpoint}] ${timestamp} request ${resolvedId} failed: ${publicSummary}${fieldSuffix ? ` (${fieldSuffix})` : ''}${timingSuffix}`;
  console.error(colorizeRequestLog(line, resolvedId) || line);
  if (rawMeta && shouldLogHttpErrorMeta()) {
    const publicRawMeta = buildPublicRawErrorMeta({
      rawMeta,
      fields,
      publicSummary
    });
    const payload = {
      requestId: resolvedId,
      endpoint,
      rawError: publicRawMeta.rawError,
      rawErrorSnippet: publicRawMeta.rawErrorSnippet
    };
    const metaLine = `[http.error.meta] ${JSON.stringify(payload)}`;
    console.error(colorizeRequestLog(metaLine, resolvedId) || metaLine);
  }
}

function resolvePrimaryErrorLogSummary(error: unknown, fallback: string): string {
  return mapErrorToPublicLogSummary(error, fallback);
}

function shouldUseRawSnippetAsSummary(rawSnippet: string | undefined, fallbackText: string): boolean {
  if (!rawSnippet || typeof rawSnippet !== 'string') {
    return false;
  }
  const trimmed = rawSnippet.trim();
  if (!trimmed) {
    return false;
  }
  if (!isCodeOnlyShellError(trimmed)) {
    return true;
  }
  // code-only shell error loses diagnostics; prefer richer normalized text.
  return !fallbackText || !fallbackText.trim();
}

function extractCodeOnlyResponseDataShell(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const bag = error as Record<string, unknown>;
  const response =
    bag.response && typeof bag.response === 'object' && !Array.isArray(bag.response)
      ? (bag.response as Record<string, unknown>)
      : undefined;
  const responseData =
    response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? response.data
      : undefined;
  if (!responseData) {
    return undefined;
  }
  try {
    return JSON.stringify(responseData);
  } catch {
    return undefined;
  }
}

function isCodeOnlyShellError(value: string): boolean {
  if (!(value.startsWith('{') && value.endsWith('}'))) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const errorNode = parsed?.error;
    if (!errorNode || typeof errorNode !== 'object' || Array.isArray(errorNode)) {
      return false;
    }
    const errorRecord = errorNode as Record<string, unknown>;
    const keys = Object.keys(errorRecord);
    if (keys.length !== 1 || keys[0] !== 'code') {
      return false;
    }
    return typeof errorRecord.code === 'string' && errorRecord.code.trim().length > 0;
  } catch {
    return false;
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
  const mapped = await resolveReportedRouteErrorHttpResponse({
    routePayload,
    normalizedError,
    onReportError: (reportError) => logHandlerNonBlockingError(`reportRouteError:${effectiveRequestId}`, reportError)
  });
  const suppressSnapshotForRoutineError =
    mapped.status === 408
    || mapped.status === 425
    || mapped.status === 429
    || mapped.status >= 500;
  assertClientErrorBodyHasNoInternalCarriers(mapped.body, effectiveRequestId);
  if (options?.forceSse) {
    // For streaming clients, return an SSE error event so the client can surface the failure.
    // Use the mapped HTTP status so clients can fail fast; embed the status in the event payload as well.
    const payload = mapped.body?.error
      ? { type: 'error', status: mapped.status, error: mapped.body.error }
      : { type: 'error', status: mapped.status, error: mapped.body };
    assertClientErrorBodyHasNoInternalCarriers(payload, effectiveRequestId);
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
    if (isSnapshotsEnabled() && !suppressSnapshotForRoutineError) {
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
  if (isSnapshotsEnabled() && !suppressSnapshotForRoutineError) {
    void writeServerSnapshot({
      phase: 'client-response.error',
      requestId: effectiveRequestId,
      entryEndpoint,
      data: { mode: 'json', status: mapped.status, body: mapped.body }
    }).catch((error) => {
      logHandlerNonBlockingError(`writeServerSnapshot:json_error:${effectiveRequestId}`, error);
    });
  }
  assertClientErrorBodyHasNoInternalCarriers(mapped.body, effectiveRequestId);
  res.status(mapped.status).json(mapped.body);
}

export async function writeStartedSsePipelineError(
  res: Response,
  ctx: HandlerContext,
  error: unknown,
  entryEndpoint: string,
  requestId: string
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
  const mapped = await resolveReportedRouteErrorHttpResponse({
    routePayload,
    normalizedError,
    onReportError: (reportError) => logHandlerNonBlockingError(`reportRouteErrorStartedSse:${effectiveRequestId}`, reportError)
  });
  const suppressSnapshotForRoutineError =
    mapped.status === 408
    || mapped.status === 425
    || mapped.status === 429
    || mapped.status >= 500;
  const payload = mapped.body?.error
    ? { type: 'error', status: mapped.status, error: mapped.body.error }
    : { type: 'error', status: mapped.status, error: mapped.body };
  try {
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (writeError) {
    logHandlerNonBlockingError(`startedSseErrorWrite:${effectiveRequestId}`, writeError);
  }
  try {
    res.end();
  } catch (endError) {
    logHandlerNonBlockingError(`startedSseErrorEnd:${effectiveRequestId}`, endError);
  }
  if (isSnapshotsEnabled() && !suppressSnapshotForRoutineError) {
    void writeServerSnapshot({
      phase: 'client-response.error',
      requestId: effectiveRequestId,
      entryEndpoint,
      data: { mode: 'sse-started', status: mapped.status, payload }
    }).catch((snapshotError) => {
      logHandlerNonBlockingError(`writeServerSnapshot:started_sse_error:${effectiveRequestId}`, snapshotError);
    });
  }
}

export async function resolveReportedRouteErrorHttpResponse(args: {
  routePayload: RouteErrorPayload;
  normalizedError: Error & Record<string, unknown>;
  onReportError?: (error: unknown) => void;
}): Promise<HttpErrorPayload> {
  const mapped = mapErrorToHttp(buildClientHttpProjectionSource(args.routePayload, args.normalizedError));
  try {
    const { reportRouteError } = await import('../../error-handling/route-error-hub.js');
    await reportRouteError(args.routePayload, { includeHttpResult: true });
  } catch (error) {
    args.onReportError?.(error);
  }
  const requestId = typeof args.routePayload.requestId === 'string' ? args.routePayload.requestId : undefined;
  if (requestId && mapped.body?.error && !mapped.body.error.request_id) {
    mapped.body.error.request_id = requestId;
  }
  return mapped;
}

function buildClientHttpProjectionSource(
  routePayload: RouteErrorPayload,
  normalizedError: Error & Record<string, unknown>
): Error & Record<string, unknown> {
  const status =
    typeof normalizedError.status === 'number'
      ? normalizedError.status
      : typeof normalizedError.statusCode === 'number'
        ? normalizedError.statusCode
        : typeof routePayload.details?.status === 'number'
          ? routePayload.details.status
          : typeof routePayload.details?.statusCode === 'number'
            ? routePayload.details.statusCode
            : undefined;
  return Object.assign(new Error(normalizedError.message), normalizedError, {
    code: typeof routePayload.code === 'string' && routePayload.code.trim()
      ? routePayload.code
      : normalizedError.code,
    ...(typeof status === 'number' ? { status, statusCode: status } : {}),
    requestId: routePayload.requestId ?? normalizedError.requestId,
    providerKey: routePayload.providerKey ?? normalizedError.providerKey,
    providerType: routePayload.providerType ?? normalizedError.providerType,
    routeName: routePayload.routeName ?? normalizedError.routeName,
    details: {
      ...(normalizedError.details && typeof normalizedError.details === 'object' && !Array.isArray(normalizedError.details)
        ? normalizedError.details as Record<string, unknown>
        : {}),
      ...(routePayload.details ?? {}),
      ...(typeof status === 'number' ? { status, statusCode: status } : {}),
      requestId: routePayload.requestId ?? normalizedError.requestId,
      providerKey: routePayload.providerKey ?? normalizedError.providerKey,
      providerType: routePayload.providerType ?? normalizedError.providerType,
      routeName: routePayload.routeName ?? normalizedError.routeName
    }
  });
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

export function readRequestBodyMetadata(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>).metadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  } catch {
    return { ...(raw as Record<string, unknown>) };
  }
}

export function stripRequestBodyMetadataForPipeline<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'metadata')) {
    return payload;
  }
  const { metadata: _metadata, ...withoutMetadata } = record;
  return withoutMetadata as T;
}

export function mergePipelineMetadata(
  requestBodyMetadata: Record<string, unknown> | undefined,
  internalMetadata: Record<string, unknown>
): Record<string, unknown> {
  const sanitizedRequestMetadata = sanitizeClientPipelineMetadata(requestBodyMetadata);
  if (!sanitizedRequestMetadata || Object.keys(sanitizedRequestMetadata).length === 0) {
    return internalMetadata;
  }
  const merged: Record<string, unknown> = {
    ...sanitizedRequestMetadata,
    ...internalMetadata
  };
  const requestRt =
    sanitizedRequestMetadata.__rt &&
    typeof sanitizedRequestMetadata.__rt === 'object' &&
    !Array.isArray(sanitizedRequestMetadata.__rt)
      ? (sanitizedRequestMetadata.__rt as Record<string, unknown>)
      : undefined;
  const internalRt =
    internalMetadata.__rt &&
    typeof internalMetadata.__rt === 'object' &&
    !Array.isArray(internalMetadata.__rt)
      ? (internalMetadata.__rt as Record<string, unknown>)
      : undefined;
  if (requestRt || internalRt) {
    merged.__rt = {
      ...(requestRt ?? {}),
      ...(internalRt ?? {})
    };
  }
  return merged;
}

// Phase Server-B: explicit whitelist + explicit denied list for client-supplied metadata.
// Unknown fields are forwarded as before, but route/runtime/provider control fields
// must be denied at entry. The list mirrors server.req_adapter module help contract.
const PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS = new Set<string>([
  'clientRequestId',
  'userAgent',
  'clientOriginator',
  'requestSource',
  'experimentFlag',
  'appVersion',
]);

const PIPELINE_METADATA_DENIED_CLIENT_FIELDS = new Set<string>([
  'routeHint',
  '__routeHint',
  'routingDecision',
  '__shadowCompareForcedProviderKey',
  '__routecodexRetryProviderKey',
  'providerKey',
  '__rt',
  'snapshot',
  'snapshotId',
  'upstreamRequestId',
  'metaCarrier',
  'runtimeMetadata',
  'errorCarrier',
  'classifiedError',
  '__raw_request_body',
]);

function sanitizeClientPipelineMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (PIPELINE_METADATA_DENIED_CLIENT_FIELDS.has(key)) {
      throw new Error(`[server.req_adapter] forbidden client metadata field: ${key}`);
    }
    if (!PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS.has(key)) {
      throw new Error(`[server.req_adapter] unsupported client metadata field: ${key}`);
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

export function __pipelineMetadataAllowedClientFields(): ReadonlySet<string> {
  return PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS;
}

export function __pipelineMetadataDeniedClientFields(): ReadonlySet<string> {
  return PIPELINE_METADATA_DENIED_CLIENT_FIELDS;
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
