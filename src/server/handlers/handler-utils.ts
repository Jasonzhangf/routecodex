import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import type { HandlerContext } from './types.js';
import {
  isClientDisconnectHttpProjectionCandidate,
  isClientDisconnectHttpProjectionSentinel,
  mapErrorToHttp,
  mapErrorToPublicLogSummary,
  type HttpErrorPayload,
} from '../utils/http-error-mapper.js';
import type { RouteErrorPayload } from '../../error-handling/route-error-hub.js';
// import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { formatErrorForConsole } from '../../utils/log-helpers.js';
import { colorizeRequestLog, formatHighlightedFinishReasonLabel, registerRequestLogContext } from '../utils/request-log-color.js';
import { deriveFinishReason } from '../utils/finish-reason.js';
import { isSnapshotsEnabled, writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { formatRequestTimingSummary } from '../utils/stage-logger.js';
import {
  generateRequestIdentifiers,
  resolveEffectiveRequestId
} from '../utils/request-id-manager.js';
import { MetadataCenter } from '../runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../runtime/http-server/metadata-center/dualwrite-api.js';
import { readRuntimeControlProjection } from '../runtime/http-server/metadata-center/request-truth-readers.js';
import { buildInboundLogSessionContext } from '../runtime/http-server/executor-metadata.js';
export { sendPipelineResponse } from './handler-response-utils.js';
import { assertClientResponseHasNoInternalCarriers as assertClientErrorBodyHasNoInternalCarriers } from './handler-response-utils.js';
import { resolveInternalDebugErrorLogFields } from '../../debug/internal-error/index.js';

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

type RequestLogMeta = Record<string, unknown> | null | undefined;

const HANDLER_RUNTIME_CONTROL_WRITER = {
  module: 'src/server/handlers/handler-utils.ts',
  symbol: 'buildHandlerPipelineMetadata',
  stage: 'handler_pipeline_runtime_control'
} as const;

const HANDLER_REQUEST_TRUTH_WRITER = {
  module: 'src/server/handlers/handler-utils.ts',
  symbol: 'buildHandlerPipelineMetadata',
  stage: 'ServerReqInbound01ClientRaw'
} as const;

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

function formatCompactLogShape(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function shouldEmitHttpErrorMeta(args: {
  rawMeta: RequestLogMeta;
  fields: { statusCode?: number; errorCode?: string; upstreamCode?: string; catalogCode?: string; catalogKey?: string };
  publicSummary: string;
}): boolean {
  if (!args.rawMeta || !shouldLogHttpErrorMeta()) {
    return false;
  }
  return !(
    args.fields.statusCode === 429
    && args.publicSummary === 'Rate limited by upstream provider'
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
  const statusMatch =
    summary.match(/\bHTTP\s+(\d{3})\b/i)
    ?? summary.match(/\bstatus(?:Code)?[=:]\s*(\d{3})\b/i)
    ?? summary.match(/"(?:status|statusCode)"\s*:\s*(\d{3})\b/i);
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
  internalCode?: string;
  upstreamCode?: string;
  catalogCode?: string;
  catalogKey?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  stage?: string;
  externalSource?: 'external_transport';
  reason?: string;
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
  const internalError =
    bag.internalError && typeof bag.internalError === 'object' && !Array.isArray(bag.internalError)
      ? (bag.internalError as Record<string, unknown>)
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
  const internalCode =
    readTrimmedString(bag.internalCode)
    ?? readTrimmedString(internalError?.internalCode)
    ?? (typeof bag.internalCode === 'number' ? String(bag.internalCode) : undefined)
    ?? (typeof internalError?.internalCode === 'number' ? String(internalError.internalCode) : undefined);
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

  const rawMetaText =
    readTrimmedString(bag.rawErrorSnippet)
    ?? readTrimmedString(bag.rawError);
  const fromText = parseFieldFromText(summary);
  const fromRawMetaText = rawMetaText ? parseFieldFromText(rawMetaText) : {};
  const resolvedErrorCode = errorCode ?? fromText.errorCode ?? fromRawMetaText.errorCode;
  const resolvedUpstreamCode = upstreamCode ?? fromText.upstreamCode ?? fromRawMetaText.upstreamCode;
  const resolvedStatusCode =
    typeof statusCode === 'number'
      ? statusCode
      : (typeof fromText.statusCode === 'number'
          ? fromText.statusCode
          : (typeof fromRawMetaText.statusCode === 'number' ? fromRawMetaText.statusCode : undefined));
  const catalogCode =
    readTrimmedString(bag.catalogCode)
    ?? readTrimmedString(details?.catalogCode)
    ?? readTrimmedString(details?.catalog_code);
  const catalogKey =
    readTrimmedString(bag.catalogKey)
    ?? readTrimmedString(details?.catalogKey)
    ?? readTrimmedString(details?.catalog_key);
  const providerKey =
    readTrimmedString(bag.providerKey)
    ?? readTrimmedString(details?.providerKey)
    ?? readTrimmedString(responseError?.providerKey);
  const providerType =
    readTrimmedString(bag.providerType)
    ?? readTrimmedString(details?.providerType)
    ?? readTrimmedString(responseError?.providerType);
  const routeName =
    readTrimmedString(bag.routeName)
    ?? readTrimmedString(details?.routeName)
    ?? readTrimmedString(responseError?.routeName);
  const stage =
    readTrimmedString(bag.requestExecutorProviderErrorStage)
    ?? readTrimmedString(details?.requestExecutorProviderErrorStage)
    ?? readTrimmedString(details?.source);
  const externalSource = resolveExternalErrorSource({
    errorCode: resolvedErrorCode,
    upstreamCode: resolvedUpstreamCode,
  });
  const reason = externalSource === 'external_transport'
    ? resolveExternalTransportReason(error, summary)
    : undefined;
  return {
    ...(typeof resolvedStatusCode === 'number' ? { statusCode: resolvedStatusCode } : {}),
    ...(resolvedErrorCode ? { errorCode: resolvedErrorCode } : {}),
    ...(internalCode ? { internalCode } : {}),
    ...(resolvedUpstreamCode ? { upstreamCode: resolvedUpstreamCode } : {}),
    ...(catalogCode ? { catalogCode } : {}),
    ...(catalogKey ? { catalogKey } : {}),
    ...(providerKey ? { providerKey } : {}),
    ...(providerType ? { providerType } : {}),
    ...(routeName ? { routeName } : {}),
    ...(stage ? { stage } : {}),
    ...(externalSource ? { externalSource } : {}),
    ...(reason ? { reason } : {})
  };
}

function resolveExternalErrorSource(args: {
  errorCode?: string;
  upstreamCode?: string;
}): 'external_transport' | undefined {
  const codes = [args.errorCode, args.upstreamCode]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toUpperCase());
  if (codes.some((code) => [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UPSTREAM_STREAM_TERMINATED',
  ].includes(code))) {
    return 'external_transport';
  }
  return undefined;
}

function resolveExternalTransportReason(error: unknown, summary: string): string | undefined {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = readTrimmedString(record.message);
    if (message) {
      const parsedMessage = parseJsonErrorMessage(message);
      return parsedMessage ?? message;
    }
  }
  const summaryMessage =
    summary.match(/"message"\s*:\s*"([^"]+)"/i)?.[1]
    ?? summary.match(/\bmessage[=:]\s*([A-Za-z0-9_. -]+)/i)?.[1];
  return summaryMessage?.trim() || undefined;
}

function parseJsonErrorMessage(value: string): string | undefined {
  if (!(value.startsWith('{') && value.endsWith('}'))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const errorNode = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : undefined;
    return readTrimmedString(errorNode?.message);
  } catch {
    return undefined;
  }
}

function buildPublicRawErrorMeta(args: {
  rawMeta: { rawError?: string; rawErrorSnippet?: string };
  fields: { statusCode?: number; errorCode?: string; upstreamCode?: string; catalogCode?: string; catalogKey?: string };
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
  if (args.fields.catalogCode) {
    errorNode.catalog_code = args.fields.catalogCode;
  }
  if (args.fields.catalogKey) {
    errorNode.catalog_key = args.fields.catalogKey;
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
          typeof bag.type === 'string' && bag.type.trim() ? `type=${bag.type}` : undefined,
          typeof bag.rawInputItems === 'number' ? `rawInputItems=${bag.rawInputItems}` : undefined,
          typeof bag.preparedInputItems === 'number' ? `preparedInputItems=${bag.preparedInputItems}` : undefined,
          typeof bag.plannedEntryMode === 'string' && bag.plannedEntryMode.trim()
            ? `plannedEntryMode=${bag.plannedEntryMode}`
            : undefined,
          typeof bag.resumeFullInputItems === 'number' ? `resumeFullInputItems=${bag.resumeFullInputItems}` : undefined,
          typeof bag.resumeDeltaInputItems === 'number' ? `resumeDeltaInputItems=${bag.resumeDeltaInputItems}` : undefined
        ]
          .filter((item): item is string => Boolean(item))
          .join(' ');
        return fields ? ` (${fields})` : '';
      })()
    : '';
  const line = `▶ [${endpoint}] ${timestamp} request ${resolvedId} started${suffix}`;
  if (meta && typeof meta === 'object') {
    registerRequestLogContext(resolvedId, meta);
  }
  console.warn(colorizeRequestLog(line, resolvedId, meta));
}

export function logRequestComplete(
  endpoint: string,
  requestId: string,
  status: number,
  body?: unknown,
  options?: { preserveTimingForUsage?: boolean; suppressCompletedLog?: boolean }
): void {
  if (!SHOULD_LOG_HTTP_EVENTS) {
    return;
  }
  const resolvedId = formatRequestId(requestId);
  if (options?.suppressCompletedLog || options?.preserveTimingForUsage) {
    if (!options?.preserveTimingForUsage) {
      formatRequestTimingSummary(resolvedId, { terminal: true });
    }
    return;
  }
  const timestamp = formatTimestamp();
  const finishReason = deriveFinishReason(body);
  const finishReasonLabel = finishReason ? `, finish_reason=${finishReason}` : '';
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
  const responseDataShell = extractCodeOnlyResponseDataShell(error);
  const summary =
    responseDataShell && isCodeOnlyShellError(responseDataShell) && formatted.text.trim()
      ? formatted.text
      : formatted.text;
  const publicSummary = resolvePrimaryErrorLogSummary(error, summary);
  const extractedFields = extractErrorLogFields(error, summary);
  const internalLogFields = resolveInternalDebugErrorLogFields({ error, summary });
  const fields = {
    ...extractedFields,
    ...internalLogFields,
  };
  const codeOnlySummary = fields.errorCode === 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT'
    ? fields.errorCode
    : undefined;
  const fieldSuffix = codeOnlySummary
    ? ''
    : [
        typeof fields.statusCode === 'number' ? `status=${fields.statusCode}` : undefined,
        fields.errorCode ? `code=${fields.errorCode}` : undefined,
        fields.internalCode ? `internalCode=${fields.internalCode}` : undefined,
        fields.upstreamCode ? `upstreamCode=${fields.upstreamCode}` : undefined,
        fields.catalogCode ? `catalogCode=${fields.catalogCode}` : undefined,
        fields.catalogKey ? `catalogKey=${fields.catalogKey}` : undefined,
        fields.providerKey ? `provider=${fields.providerKey}` : undefined,
        fields.providerType ? `providerType=${fields.providerType}` : undefined,
        fields.routeName ? `route=${fields.routeName}` : undefined,
        fields.stage ? `stage=${fields.stage}` : undefined,
        fields.externalSource ? `source=${fields.externalSource}` : undefined,
        fields.reason ? `reason=${JSON.stringify(fields.reason)}` : undefined,
      ]
        .filter((item): item is string => Boolean(item))
        .join(' ');
  const timestamp = formatTimestamp();
  const timingSuffix = formatRequestTimingSummary(resolvedId, { terminal: true });
  const line = `❌ [${endpoint}] ${timestamp} request ${resolvedId} failed: ${codeOnlySummary ?? publicSummary}${fieldSuffix ? ` (${fieldSuffix})` : ''}${timingSuffix}`;
  console.error(colorizeRequestLog(line, resolvedId, undefined, { isError: true }) || line);
  if (rawMeta && shouldEmitHttpErrorMeta({ rawMeta, fields, publicSummary })) {
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
    console.error(colorizeRequestLog(metaLine, resolvedId, undefined, { isError: true }) || metaLine);
  }
}

function resolvePrimaryErrorLogSummary(error: unknown, fallback: string): string {
  return mapErrorToPublicLogSummary(error, fallback);
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
  if (isClientDisconnectHttpProjectionSentinel(normalizedError)
    || isClientDisconnectHttpProjectionCandidate(normalizedError)) {
    terminateClientDisconnectedResponse(res, effectiveRequestId, options?.forceSse === true ? 'sse' : 'json');
    return;
  }
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
    details: buildRouteErrorDetails(normalizedError, entryEndpoint, effectiveRequestId),
    originalError: buildRouteErrorOriginalError(normalizedError, entryEndpoint, effectiveRequestId)
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
  if (isClientDisconnectHttpProjectionSentinel(normalizedError)
    || isClientDisconnectHttpProjectionCandidate(normalizedError)) {
    terminateClientDisconnectedResponse(res, effectiveRequestId, 'sse-started');
    return;
  }
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
    details: buildRouteErrorDetails(normalizedError, entryEndpoint, effectiveRequestId),
    originalError: buildRouteErrorOriginalError(normalizedError, entryEndpoint, effectiveRequestId)
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

function terminateClientDisconnectedResponse(
  res: Response,
  requestId: string,
  mode: 'json' | 'sse' | 'sse-started'
): void {
  try {
    const maybeDestroy = res as Response & { destroy?: () => void };
    if (typeof maybeDestroy.destroy === 'function') {
      maybeDestroy.destroy();
      return;
    }
    res.end();
  } catch (error) {
    logHandlerNonBlockingError(`clientDisconnectTerminate:${mode}:${requestId}`, error);
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
  const shouldAttachRequestId = mapped.body?.error?.code !== 'upstream_error';
  if (requestId && shouldAttachRequestId && mapped.body?.error && !mapped.body.error.request_id) {
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
      ...(routePayload.details ?? {}),
      ...(typeof status === 'number' ? { status, statusCode: status } : {}),
      requestId: routePayload.requestId ?? normalizedError.requestId,
      providerKey: routePayload.providerKey ?? normalizedError.providerKey,
      providerType: routePayload.providerType ?? normalizedError.providerType,
      routeName: routePayload.routeName ?? normalizedError.routeName
    }
  });
}

function readSafeErrorDetail(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function readSafeStringRecordField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function buildRouteErrorDetails(
  normalizedError: Error & Record<string, unknown>,
  endpoint: string,
  requestId: string
): Record<string, unknown> {
  const details =
    normalizedError.details && typeof normalizedError.details === 'object' && !Array.isArray(normalizedError.details)
      ? (normalizedError.details as Record<string, unknown>)
      : {};
  const safe: Record<string, unknown> = {
    endpoint,
    requestId,
  };
  for (const key of [
    'status',
    'statusCode',
    'code',
    'errorCode',
    'upstreamCode',
    'upstreamStatus',
    'catalogCode',
    'catalogKey',
    'providerKey',
    'providerType',
    'providerFamily',
    'routeName',
    'requestExecutorProviderErrorStage',
    'reason',
    'retryable',
  ]) {
    const value = readSafeErrorDetail(normalizedError[key]) ?? readSafeErrorDetail(details[key]);
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  const rawErrorSnippet =
    readSafeStringRecordField(normalizedError, 'rawErrorSnippet')
    ?? readSafeStringRecordField(details, 'rawErrorSnippet');
  if (rawErrorSnippet) {
    safe.rawErrorSnippet = rawErrorSnippet;
  }
  return safe;
}

function buildRouteErrorOriginalError(
  normalizedError: Error & Record<string, unknown>,
  endpoint: string,
  requestId: string
): Error & Record<string, unknown> {
  const safe = new Error(normalizedError.message) as Error & Record<string, unknown>;
  safe.name = normalizedError.name;
  safe.endpoint = endpoint;
  safe.requestId = requestId;
  const safeDetails = buildRouteErrorDetails(normalizedError, endpoint, requestId);
  for (const [key, value] of Object.entries(safeDetails)) {
    safe[key] = value;
  }
  safe.details = safeDetails;
  return safe;
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

export function buildHandlerPipelineMetadata(
  requestBodyMetadata: Record<string, unknown> | undefined,
  internalMetadata: Record<string, unknown>
): Record<string, unknown> {
  const sanitizedRequestMetadata = sanitizeClientPipelineMetadata(requestBodyMetadata);
  const merged = sanitizedRequestMetadata && Object.keys(sanitizedRequestMetadata).length > 0
    ? {
        ...sanitizedRequestMetadata,
        ...internalMetadata
      }
    : { ...internalMetadata };
  const metadataCenter = MetadataCenter.read(internalMetadata) ?? MetadataCenter.attach(merged);
  MetadataCenter.bind(merged, metadataCenter);
  const existingRequestTruth = metadataCenter.readRequestTruth();
  const requestId =
    typeof internalMetadata.requestId === 'string' && internalMetadata.requestId.trim()
      ? internalMetadata.requestId.trim()
      : undefined;
  if (requestId && !existingRequestTruth.requestId) {
    writeMetadataCenterSlot({
      target: merged,
      family: 'request_truth',
      key: 'requestId',
      value: requestId,
      writer: HANDLER_REQUEST_TRUTH_WRITER,
      reason: 'handler canonical request id'
    });
  }
  const clientRequestId =
    typeof internalMetadata.clientRequestId === 'string' && internalMetadata.clientRequestId.trim()
      ? internalMetadata.clientRequestId.trim()
      : undefined;
  if (clientRequestId && !existingRequestTruth.clientRequestId) {
    writeMetadataCenterSlot({
      target: merged,
      family: 'request_truth',
      key: 'clientRequestId',
      value: clientRequestId,
      writer: HANDLER_REQUEST_TRUTH_WRITER,
      reason: 'handler canonical client request id'
    });
  }
  const portContext = internalMetadata.portContext && typeof internalMetadata.portContext === 'object' && !Array.isArray(internalMetadata.portContext)
    ? (internalMetadata.portContext as Record<string, unknown>)
    : undefined;
  if (typeof portContext?.matchedPort === 'number' && Number.isFinite(portContext.matchedPort)) {
    merged.matchedPort = Math.floor(portContext.matchedPort);
  }
  if (typeof portContext?.localPort === 'number' && Number.isFinite(portContext.localPort)) {
    merged.localPort = Math.floor(portContext.localPort);
  }
  if (typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()) {
    merged.portScope = portContext.routingPolicyGroup.trim();
  }
  if (readRuntimeControlProjection(merged).streamIntent === undefined) {
    const streamIntent =
      internalMetadata.stream === true
      || internalMetadata.inboundStream === true
      || internalMetadata.outboundStream === true
        ? 'stream'
        : 'non_stream';
    writeMetadataCenterSlot({
      target: merged,
      family: 'runtime_control',
      key: 'streamIntent',
      value: streamIntent,
      writer: HANDLER_RUNTIME_CONTROL_WRITER,
      reason: 'handler stream intent'
    });
  }
  const clientAbortSignal =
    internalMetadata.clientConnectionState
    && typeof internalMetadata.clientConnectionState === 'object'
    && !Array.isArray(internalMetadata.clientConnectionState)
      ? (internalMetadata.clientConnectionState as { abortSignal?: AbortSignal }).abortSignal
      : undefined;
  writeMetadataCenterSlot({
    target: merged,
    family: 'runtime_control',
    key: 'clientAbort',
    value: clientAbortSignal?.aborted === true,
    writer: HANDLER_RUNTIME_CONTROL_WRITER,
    reason: 'handler client abort state'
  });
  delete merged.stream;
  delete merged.inboundStream;
  delete merged.outboundStream;
  return merged;
}

export function buildHandlerLogMetadata(args: {
  entryEndpoint: string;
  headers: Record<string, unknown>;
  requestBodyMetadata?: Record<string, unknown>;
  clientHeaders?: Record<string, string>;
  portContext?: HandlerContext['portContext'];
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return buildInboundLogSessionContext({
    entryEndpoint: args.entryEndpoint,
    headers: args.headers,
    bodyMetadata: args.requestBodyMetadata,
    metadata: {
      ...(args.requestBodyMetadata ?? {}),
      ...(args.clientHeaders ? { clientHeaders: args.clientHeaders } : {}),
      ...(args.metadata ?? {})
    },
    portContext: args.portContext as Record<string, unknown> | undefined
  });
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
  'sessionId',
  'session_id',
  'conversationId',
  'conversation_id',
  'client_tmux_session_id',
  'rcc_session_client_tmux_session_id',
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
