import type { ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { resolveProviderFailureOutcome } from './provider-failure-policy.js';
import { applyProviderConfiguredErrorMapping } from './provider-configured-error-mapping.js';
import { formatUnknownError, isRecord } from '../../../utils/common-utils.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';

export type ResponsesStreamingMode = 'auto' | 'always' | 'never';

export type ResponsesProviderConfig = {
  streaming?: ResponsesStreamingMode;
};

export type SubmitToolOutputsPayload = {
  responseId: string;
  body: Record<string, unknown>;
};

export type NormalizedUpstreamError = Error & {
  type?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  status?: number;
  statusCode?: number;
  code?: string;
  response?: {
    status?: number;
    raw?: string;
    data?: {
      error?: Record<string, unknown>;
    };
  };
};

export type ResponsesFailure = {
  message: string;
  status?: string;
  statusCode?: number;
  code?: string;
  recoverable: boolean;
  affectsHealth: boolean;
  rawError?: Record<string, unknown>;
  normalizedError: NormalizedUpstreamError;
};

export type ResponsesFailureTransport = {
  expectedMode?: 'sse';
  responseKind?: 'json' | 'text';
  contentType?: string;
  statusCode?: number;
};


function parseStreamingMode(value: unknown): ResponsesStreamingMode {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'always' || lowered === 'never') {
      return lowered;
    }
    if (lowered === 'auto') {
      return 'auto';
    }
  }
  return 'auto';
}

export function extractResponsesConfig(config: UnknownObject): ResponsesProviderConfig {
  const container = isRecord(config) ? (config as Record<string, unknown>) : {};
  const providerConfig = isRecord(container.config)
    ? (container.config as Record<string, unknown>)
    : undefined;
  const responsesCfg = providerConfig && isRecord(providerConfig.responses)
      ? (providerConfig.responses as Record<string, unknown>)
      : isRecord(container.responses)
      ? (container.responses as Record<string, unknown>)
      : undefined;
  if (!responsesCfg) {
    return {};
  }
  return {
    streaming: 'streaming' in responsesCfg ? parseStreamingMode(responsesCfg.streaming) : undefined
  };
}

export function buildTargetUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${normalizedBase}/${normalizedEndpoint}`;
}

export function extractStreamFlagFromBody(body: Record<string, unknown>): boolean | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const direct = (body as Record<string, unknown>).stream;
  if (typeof direct === 'boolean') {
    return direct;
  }
  const parameters = (body as Record<string, unknown>).parameters;
  if (parameters && typeof parameters === 'object') {
    const nested = (parameters as Record<string, unknown>).stream;
    if (typeof nested === 'boolean') {
      return nested;
    }
  }
  return undefined;
}

export function extractEntryEndpoint(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const runtimeMetadata = extractProviderRuntimeMetadata(source);
  const runtimeNode =
    runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? (runtimeMetadata.metadata as Record<string, unknown>)
      : undefined;
  if (runtimeNode && 'entryEndpoint' in runtimeNode) {
    const value = runtimeNode.entryEndpoint;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

export function extractResponsesDirectPassthroughFlag(source: unknown): boolean {
  if (!source || typeof source !== 'object') {
    return false;
  }
  const runtimeMetadata = extractProviderRuntimeMetadata(source);
  const runtimeNode =
    runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object'
      ? (runtimeMetadata.metadata as Record<string, unknown>)
      : undefined;
  if (runtimeNode?.__responsesDirectPassthrough === true) {
    return true;
  }
  return false;
}

export function extractSubmitToolOutputsPayload(request: UnknownObject): SubmitToolOutputsPayload | null {
  if (!request || typeof request !== 'object') {
    return null;
  }
  const record = request as Record<string, unknown>;
  const rawId =
    typeof record.response_id === 'string'
      ? record.response_id
      : typeof record.responseId === 'string'
        ? record.responseId
        : undefined;
  const responseId = rawId && rawId.trim().length ? rawId.trim() : undefined;
  if (!responseId) {
    return null;
  }
  const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : null;
  if (!toolOutputs || !toolOutputs.length) {
    return null;
  }
  const submitBody = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  delete submitBody.response_id;
  delete submitBody.responseId;
  return {
    responseId,
    body: submitBody
  };
}

export function buildSubmitToolOutputsEndpoint(baseEndpoint: string, responseId: string): string {
  const normalizedBase = baseEndpoint.replace(/\/+$/, '');
  const encodedId = encodeURIComponent(responseId);
  return `${normalizedBase}/${encodedId}/submit_tool_outputs`;
}

export function extractClientRequestId(context: ProviderContext): string | undefined {
  const metaValue = context.metadata && typeof context.metadata === 'object'
    ? (context.metadata as Record<string, unknown>).clientRequestId
    : undefined;
  if (typeof metaValue === 'string' && metaValue.trim().length) {
    return metaValue.trim();
  }
  const runtimeMeta = context.runtimeMetadata?.metadata;
  if (runtimeMeta && typeof runtimeMeta === 'object') {
    const candidate = (runtimeMeta as Record<string, unknown>).clientRequestId;
    if (typeof candidate === 'string' && candidate.trim().length) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function normalizeUpstreamError(error: unknown): NormalizedUpstreamError {
  const normalized = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const err = normalized as NormalizedUpstreamError;
  const message = typeof err.message === 'string' ? err.message : String(err || '');
  const match = message.match(/HTTP\s+(\d{3})/i);
  const existing =
    typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : undefined;
  const statusCode = existing ?? (match ? Number(match[1]) : undefined);
  if (typeof statusCode === 'number' && !Number.isNaN(statusCode)) {
    err.statusCode = statusCode;
    err.status = statusCode;
    if (!err.code) {
      err.code = `HTTP_${statusCode}`;
    }
  }
  if (!err.response) {
    err.response = {};
  }
  if (!err.response.data) {
    err.response.data = {};
  }
  if (!err.response.data.error) {
    err.response.data.error = {};
  }
  if (err.code && !err.response.data.error.code) {
    err.response.data.error.code = err.code;
  }
  return err;
}

function isHtmlLikeTextPayload(payload: unknown): boolean {
  if (typeof payload !== 'string') {
    return false;
  }
  const trimmed = payload.trimStart().slice(0, 256).toLowerCase();
  return trimmed.startsWith('<!doctype html')
    || trimmed.startsWith('<html')
    || trimmed.includes('<head')
    || trimmed.includes('<body');
}

function buildMalformedStreamingResponseFailure(args: {
  payload: unknown;
  transport: ResponsesFailureTransport;
  context?: ProviderContext;
}): ResponsesFailure {
  const contentType = typeof args.transport.contentType === 'string' && args.transport.contentType.trim().length
    ? args.transport.contentType.trim()
    : 'unknown';
  const responseKind = args.transport.responseKind ?? 'text';
  const htmlLike = isHtmlLikeTextPayload(args.payload);
  const message = htmlLike
    ? `Responses streaming request received HTML instead of SSE (${contentType})`
    : `Responses streaming request received non-SSE ${responseKind} response (${contentType})`;
  const rawError = {
    code: 'MALFORMED_RESPONSE',
    type: 'invalid_response_error',
    message,
    content_type: contentType,
    response_kind: responseKind
  } as Record<string, unknown>;
  const syntheticError = Object.assign(new Error(message), {
    code: 'MALFORMED_RESPONSE',
    status: args.transport.statusCode ?? 200,
    statusCode: args.transport.statusCode ?? 200,
    response: {
      status: args.transport.statusCode ?? 200,
      raw: typeof args.payload === 'string' ? args.payload : undefined,
      data: {
        error: rawError
      }
    }
  }) as NormalizedUpstreamError;
  const normalizedError = normalizeUpstreamError(syntheticError);
  normalizedError.retryable = true;
  if (args.context) {
    applyProviderConfiguredErrorMapping({
      normalized: normalizedError as any,
      context: args.context,
      statusCode: normalizedError.statusCode ?? normalizedError.status
    });
  }
  const effectiveStatusCode = normalizedError.statusCode ?? normalizedError.status ?? args.transport.statusCode ?? 200;
  const outcome = resolveProviderFailureOutcome({
    error: normalizedError,
    stage: 'provider.responses',
    statusCode: effectiveStatusCode,
    errorCode: normalizedError.code,
    upstreamCode:
      typeof normalizedError.response?.data?.error?.code === 'string'
        ? normalizedError.response.data.error.code
        : undefined,
    reason: normalizedError.message
  });
  return {
    message: normalizedError.message,
    statusCode: effectiveStatusCode,
    code: normalizedError.code,
    recoverable: outcome.recoverable,
    affectsHealth: outcome.affectsHealth,
    rawError,
    normalizedError
  };
}

export function detectResponsesFailure(
  payload: unknown,
  context?: ProviderContext,
  transport?: ResponsesFailureTransport
): ResponsesFailure | null {
  if (transport?.expectedMode === 'sse' && transport.responseKind === 'text') {
    return buildMalformedStreamingResponseFailure({
      payload,
      transport,
      context
    });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const record =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root.body && typeof root.body === 'object' && !Array.isArray(root.body)
        ? (root.body as Record<string, unknown>)
        : root;
  const status = typeof record.status === 'string' ? record.status : undefined;
  const errorCandidate = record.error;
  const errorRecord = errorCandidate && typeof errorCandidate === 'object' && !Array.isArray(errorCandidate)
    ? (errorCandidate as Record<string, unknown>)
    : undefined;
  if (status !== 'failed' && !errorRecord) {
    return null;
  }
  const message = typeof errorRecord?.message === 'string'
    ? errorRecord.message
    : `Responses request failed${status ? ` (${status})` : ''}`;
  const code = typeof errorRecord?.code === 'string'
    ? errorRecord.code
    : status === 'failed'
      ? 'RESPONSES_FAILED'
      : undefined;
  const httpStatus = typeof errorRecord?.['http_status'] === 'number'
    ? (errorRecord['http_status'] as number)
    : undefined;
  const embeddedStatus = typeof errorRecord?.status === 'number'
    ? (errorRecord.status as number)
    : undefined;
  const statusCode = httpStatus ?? embeddedStatus ?? extractStatusFromErrorCode(code);
  const syntheticError = Object.assign(new Error(message), code ? { code } : {}) as NormalizedUpstreamError;
  syntheticError.response = {
    status: statusCode,
    raw: errorRecord ? JSON.stringify({ error: errorRecord }) : undefined,
    data: {
      error: errorRecord ? { ...errorRecord } : {}
    }
  };
  const normalizedError = normalizeUpstreamError(syntheticError);
  const originalStatusCode = normalizedError.statusCode ?? normalizedError.status ?? statusCode;
  if (context) {
    applyProviderConfiguredErrorMapping({
      normalized: normalizedError as any,
      context,
      statusCode: originalStatusCode
    });
  }
  const effectiveStatusCode = normalizedError.statusCode ?? normalizedError.status ?? statusCode;
  const outcome = resolveProviderFailureOutcome({
    error: normalizedError,
    stage: 'provider.responses',
    statusCode: effectiveStatusCode,
    errorCode: normalizedError.code,
    upstreamCode:
      typeof normalizedError.response?.data?.error?.code === 'string'
        ? normalizedError.response.data.error.code
        : undefined,
    reason: normalizedError.message
  });
  return {
    message: normalizedError.message,
    statusCode: effectiveStatusCode,
    code: normalizedError.code,
    recoverable: outcome.recoverable,
    affectsHealth: outcome.affectsHealth,
    status,
    rawError: normalizedError.response?.data?.error,
    normalizedError
  };
}

function extractStatusFromErrorCode(code?: string): number | undefined {
  if (typeof code !== 'string') {
    return undefined;
  }
  const numericMatch = code.match(/(\d{3})/);
  if (numericMatch) {
    const candidate = Number(numericMatch[1] ?? numericMatch[0]);
    if (!Number.isNaN(candidate)) {
      return candidate;
    }
  }
  const lowered = code.toLowerCase();
  if (lowered.includes('quota') || lowered.includes('billing')) {
    return 402;
  }
  if (lowered.includes('unauthorized') || lowered.includes('auth')) {
    return 401;
  }
  if (lowered.includes('rate') || lowered.includes('limit')) {
    return 429;
  }
  return undefined;
}
