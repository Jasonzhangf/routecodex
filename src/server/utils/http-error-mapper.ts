import { projectSseErrorEventPayloadNative } from '../../modules/llmswitch/bridge.js';

export interface HttpErrorPayload {
  status: number;
  body: {
    error: {
      message: string;
      code?: string;
      request_id?: string;
      provider_key?: string;
      route_name?: string;
      provider_type?: string;
      upstream_status?: number;
      upstream_code?: string;
      upstream_message?: string;
      internalCode?: string;
      tool_name?: string;
      validation_reason?: string;
      validation_message?: string;
      missing_fields?: string[];
      details?: Record<string, unknown>;
    };
  };
}

export const ERROR_CLIENT_PROJECTION_FEATURE_ID = 'feature_id: error.client_projection';

/**
 * Minimal structural view of the ErrorErr05ExecutionDecision needed for
 * client-projection gating. The single owning builder is
 * `error.execution_decision_consumer` (resolveProviderRetryExecutionPlan
 * + resolveProviderRetryExecutionPlanExhaustionGate). The full
 * ProviderRetryExecutionPlan is the canonical type; this view exists only
 * here so the projection gate can be unit-tested without a full executor.
 */
export type ErrorErr05ExecutionDecision = {
  mayProject: boolean;
  policyExhausted: boolean;
  routePoolRemainingAfterExclusion: readonly string[];
  defaultPoolAvailable: boolean;
};
/**
 * `callerMayProject` is the only client-projection predicate.
 * Locked by docs/goals/provider-error-reroutable-until-pool-and-default-empty.md §2.1.
 * This is a pure type-guard; it never inspects error message / status / code.
 */
export function callerMayProject(decision: ErrorErr05ExecutionDecision | null | undefined): boolean {
  if (!decision || typeof decision !== 'object') {
    return false;
  }
  return decision.mayProject === true && decision.policyExhausted === true;
}
/**
 * Sentinel thrown by `mapErrorToHttp(decision)` when the decision is not
 * projectable (i.e. route pool still has remaining candidates or default pool
 * is still available). Callers must catch this and let the executor continue
 * the reroute path; rethrowing is the correct response.
 */
export class EarlyProjectionBlockedError extends Error {
  readonly code = 'EARLY_PROJECTION_BLOCKED';
  readonly statusCode = 500;
  readonly decision: ErrorErr05ExecutionDecision;
  constructor(decision: ErrorErr05ExecutionDecision) {
    super('ErrorErr05 decision is not projectable: route pool or default pool still has remaining candidates');
    this.name = 'EarlyProjectionBlockedError';
    this.decision = decision;
  }
}
export function isEarlyProjectionBlockedError(error: unknown): boolean {
  return error instanceof EarlyProjectionBlockedError
    || (Boolean(error)
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'EARLY_PROJECTION_BLOCKED');
}
export type ErrorErr06ClientProjected = HttpErrorPayload;

export type SseErrorEventPayload = {
  type: 'error';
  status: number;
  error: HttpErrorPayload['body']['error'];
};

const CLIENT_DISCONNECT_PUBLIC_CODE = 'CLIENT_DISCONNECTED';

type RawErrorDetails = {
  status?: number;
  requestId?: string;
  request_id?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  upstreamCode?: string;
  upstreamMessage?: string;
  toolName?: string;
  validationReason?: string;
  validationMessage?: string;
  missingFields?: unknown;
  policyExhausted?: boolean;
  candidateExhausted?: boolean;
};

type RawErrorPayload = {
  message?: string;
  status?: number;
  statusCode?: number;
  requestId?: string;
  request_id?: string;
  code?: string;
  upstreamCode?: string;
  upstreamMessage?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  toolName?: string;
  validationReason?: string;
  validationMessage?: string;
  missingFields?: unknown;
  details?: RawErrorDetails;
  response?: {
    data?: {
      error?: {
        code?: string;
        message?: string;
        status?: number;
      };
    };
  };
};

type PublicUpstreamError = {
  message?: string;
  code?: string;
  status?: number;
};

const SENSITIVE_UPSTREAM_MESSAGE_PATTERNS = [
  /invalid\s+token/i,
  /api[_ -]?key/i,
  /bearer\s+[a-z0-9._~+/=-]+/i,
  /authorization/i,
  /secret/i,
  /token\s*[:=]/i,
  /key\s*[:=]/i,
];

function normalizePublicUpstreamError(args: {
  status: number;
  baseMessage: string;
  effectiveUpstreamMessage?: string;
  upstreamMessage?: string;
  upstreamCode?: string;
  effectiveCode?: string;
  sourceCode?: string;
}): PublicUpstreamError {
  const rawCode = extractString(args.upstreamCode) || extractString(args.effectiveCode) || extractString(args.sourceCode);
  const code = normalizePublicUpstreamCode(rawCode);
  const rawMessage =
    extractString(args.effectiveUpstreamMessage)
    || extractString(args.upstreamMessage)
    || extractMessageFromHttpText(args.baseMessage);
  const message = normalizePublicUpstreamMessage({
    status: args.status,
    message: rawMessage,
    code,
  });
  return {
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    status: args.status,
  };
}

function normalizePublicUpstreamCode(code?: string): string | undefined {
  const raw = extractString(code);
  if (!raw) {
    return undefined;
  }
  if (raw === 'upstream_error') {
    return undefined;
  }
  return raw;
}

function normalizePublicUpstreamMessage(args: {
  status: number;
  message?: string;
  code?: string;
}): string | undefined {
  const raw = extractString(args.message);
  if (!raw) {
    return undefined;
  }
  if (args.status === 401 && isSensitiveUpstreamMessage(raw)) {
    return 'Upstream authentication failed';
  }
  return sanitizePublicUpstreamMessage(raw);
}

function isSensitiveUpstreamMessage(message: string): boolean {
  return SENSITIVE_UPSTREAM_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function sanitizePublicUpstreamMessage(message: string): string {
  return message
    .replace(/^Error from provider \([^)]+\):\s*/i, '')
    .replace(/^Error from provider:\s*/i, '')
    .trim();
}

function extractMessageFromHttpText(value?: string): string | undefined {
  const text = extractString(value);
  if (!text) {
    return undefined;
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    const withoutPrefix = text.replace(/^HTTP\s+\d{3}\s*:\s*/i, '').trim();
    return withoutPrefix && withoutPrefix !== text ? withoutPrefix : undefined;
  }
  const candidate = text.slice(firstBrace, lastBrace + 1);
  if (candidate.length > 200_000) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return extractErrorMessageFromUnknown(parsed);
  } catch {
    return undefined;
  }
}

function extractErrorMessageFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const errorNode = record.error;
  if (typeof errorNode === 'string') {
    return extractString(errorNode);
  }
  if (errorNode && typeof errorNode === 'object' && !Array.isArray(errorNode)) {
    const errorRecord = errorNode as Record<string, unknown>;
    const message = extractString(errorRecord.message);
    if (message) {
      return message;
    }
    const nested = extractErrorMessageFromUnknown(errorRecord);
    if (nested) {
      return nested;
    }
  }
  return extractString(record.message);
}

function tryExtractNestedJsonErrorMessage(raw?: string): { message?: string; requestId?: string; type?: string } | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text.startsWith('HTTP ')) {
    return null;
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  // Prevent pathological parsing on extremely large payloads.
  const candidate = text.slice(firstBrace, lastBrace + 1);
  if (candidate.length > 200_000) {
    return null;
  }
  try {
    const outer = JSON.parse(candidate) as {
      error?: { message?: unknown };
    };
    const innerRaw = outer?.error?.message;
    if (typeof innerRaw !== 'string' || !innerRaw.trim().startsWith('{')) {
      return null;
    }
    const inner = JSON.parse(innerRaw) as {
      type?: unknown;
      request_id?: unknown;
      error?: { type?: unknown; message?: unknown };
    };
    const message =
      typeof inner?.error?.message === 'string'
        ? inner.error.message.trim()
        : undefined;
    const requestId = typeof inner?.request_id === 'string' ? inner.request_id.trim() : undefined;
    const type =
      typeof inner?.error?.type === 'string'
        ? inner.error.type.trim()
        : typeof inner?.type === 'string'
          ? inner.type.trim()
          : undefined;
    if (!message && !requestId && !type) {
      return null;
    }
    return { message, requestId, type };
  } catch {
    return null;
  }
}

function isInternalBadResponseStatusLike(args: {
  baseMessage: string;
  upstreamMessage?: string;
  effectiveUpstreamMessage?: string;
  code?: string;
  upstreamCode?: string;
}): boolean {
  const codes = [args.code, args.upstreamCode]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (codes.includes('bad_response_status_code')) {
    return true;
  }
  const hints = [args.baseMessage, args.upstreamMessage, args.effectiveUpstreamMessage]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());
  return hints.some((hint) => hint.includes('openai_error') || hint.includes('bad_response_status_code'));
}

/**
 * Sentinel error thrown by `mapErrorToHttp` when the error represents a client_disconnect
 * transport cancellation (HTTP_499 / `client abort request` / `client closed request` /
 * `CLIENT_DISCONNECTED`). Per
 * `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md` §0.4, client_disconnect
 * is non-projectable: there is no client-visible HTTP status code, no JSON body, and no
 * SSE event frame. Callers must `catch` this sentinel, terminate the response silently
 * (res.end / res.destroy), and tag internal logs / usage summary with `client_disconnect=true`.
 */
export class ClientDisconnectHttpProjectionError extends Error {
  readonly code = 'CLIENT_DISCONNECT_NON_PROJECTABLE';
  readonly statusCode = 0;
  readonly requestId: string | undefined;
  constructor(requestId?: string, message = 'client_disconnect non-projectable sentinel') {
    super(message);
    this.name = 'ClientDisconnectHttpProjectionError';
    this.requestId = requestId;
  }
}

export function isClientDisconnectHttpProjectionSentinel(error: unknown): boolean {
  return error instanceof ClientDisconnectHttpProjectionError
    || (Boolean(error)
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'CLIENT_DISCONNECT_NON_PROJECTABLE');
}

export function mapErrorToHttp(err: unknown): HttpErrorPayload {
  const error = normalizeErrorPayload(err);
  const baseMessage = typeof error.message === 'string' ? error.message : String(err ?? 'Unknown error');
  const statusFromErr = extractStatus(error);
  const upstream = extractUpstreamError(error);
  const status = normalizeStatus(statusFromErr, upstream.status);
  const requestId = sanitizePublicRequestId(extractRequestId(error));
  const upstreamCode = upstream.code;
  const upstreamMessage = upstream.message;
  const nestedJson = tryExtractNestedJsonErrorMessage(upstreamMessage || baseMessage);
  const effectiveUpstreamMessage = nestedJson?.message || upstreamMessage;
  const effectiveCode = upstream.code || extractString(error.code) || 'upstream_error';
  const sourceCode = extractString(error.code);
  const publicUpstream = normalizePublicUpstreamError({
    status,
    baseMessage,
    effectiveUpstreamMessage,
    upstreamMessage,
    upstreamCode,
    effectiveCode,
    sourceCode,
  });
  const toolName = extractString(error.toolName) || extractString(error.details?.toolName);
  const validationReason =
    extractString(error.validationReason) || extractString(error.details?.validationReason);
  const validationMessage =
    extractString(error.validationMessage) || extractString(error.details?.validationMessage);
  const missingFields = normalizeStringArray(error.missingFields ?? error.details?.missingFields);
  const validationFields = {
    ...(toolName ? { tool_name: toolName } : {}),
    ...(validationReason ? { validation_reason: validationReason } : {}),
    ...(validationMessage ? { validation_message: validationMessage } : {}),
    ...(missingFields?.length ? { missing_fields: missingFields } : {})
  };

  const publicDetails = sanitizePublicErrorDetails(error.details);
  const shouldExposeDetails = String(effectiveCode || '').trim().toUpperCase() === 'PROVIDER_NOT_AVAILABLE';
  const detailField = shouldExposeDetails && publicDetails ? { details: publicDetails } : {};

  // Protocol/shape errors produced by our bridge/pipeline should be treated as client errors.
  // (e.g. /v1/responses with invalid payload shape)
  const normalizedCode = String(effectiveCode || '').trim().toUpperCase();
  const normalizedSourceCode = String(sourceCode || '').trim().toUpperCase();
  if (normalizedCode === 'MALFORMED_REQUEST') {
    return formatPayload(400, {
      message: baseMessage || 'Malformed request',
      code: 'MALFORMED_REQUEST',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (normalizedCode === 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT') {
    return formatPayload(500, {
      message: baseMessage || 'Responses conversation request context missing for response capture',
      code: 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT',
      internalCode: 'RESPONSES_STORE_MISSING_REQUEST_CONTEXT',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (isClientDisconnectHttpProjectionCandidate(error)) {
    throw new ClientDisconnectHttpProjectionError(requestId);
  }

  const timeoutHint = `${baseMessage} ${extractString(error.code) || ''} ${extractString(upstreamCode) || ''}`.toLowerCase();
  if (
    timeoutHint.includes('timeout') ||
    timeoutHint.includes('upstream_stream_timeout') ||
    timeoutHint.includes('upstream_stream_idle_timeout') ||
    timeoutHint.includes('upstream_headers_timeout')
  ) {
    return formatPayload(504, {
      message: 'Upstream request timed out',
      code: sourceCode || upstreamCode || effectiveCode || 'gateway_timeout',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 429) {
    if (normalizedSourceCode === 'PROVIDER_BUSINESS_ERROR') {
      return formatPayload(429, {
        message: effectiveUpstreamMessage || upstreamMessage || baseMessage,
        code: upstreamCode || effectiveCode,
        request_id: requestId,
        ...validationFields,
        ...detailField
      });
    }
    return formatPayload(429, {
      message: 'Rate limited by upstream provider',
      code: upstreamCode || effectiveCode || 'rate_limit',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 401 || status === 403) {
    return formatPayload(502, {
      message: publicUpstream.message || 'Upstream provider error',
      code: publicUpstream.code || 'upstream_error',
      upstream_status: status,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 501) {
    return formatPayload(501, {
      message: 'Requested provider capability is not implemented',
      code: upstreamCode || effectiveCode || 'not_implemented',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status >= 400 && status < 500) {
    if (normalizedSourceCode === 'PROVIDER_BUSINESS_ERROR') {
      return formatPayload(status, {
        message: effectiveUpstreamMessage || upstreamMessage || baseMessage,
        code: upstreamCode || effectiveCode,
        request_id: requestId,
        ...validationFields,
        ...detailField
      });
    }
    return formatPayload(status, {
      message: publicUpstream.message || 'Upstream rejected the request',
      code: publicUpstream.code || 'upstream_client_error',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 502 && isInternalBadResponseStatusLike({
    baseMessage,
    upstreamMessage,
    effectiveUpstreamMessage,
    code: effectiveCode,
    upstreamCode,
  })) {
    const internalCode =
      extractString(error.response?.data?.error?.code)
      || upstreamCode
      || effectiveCode
      || 'internal_provider_response_error';
    return formatPayload(502, {
      message: 'Internal provider response error',
      code: sourceCode || internalCode,
      internalCode,
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  return formatPayload(502, {
    message: publicUpstream.message || 'Upstream provider error',
    code: publicUpstream.code || 'upstream_error',
    request_id: requestId,
    ...(typeof publicUpstream.status === 'number' ? { upstream_status: publicUpstream.status } : {}),
    ...validationFields,
    ...detailField
  });
}

export function isClientDisconnectHttpProjectionCandidate(err: unknown): boolean {
  const error = normalizeErrorPayload(err);
  const baseMessage = typeof error.message === 'string' ? error.message : String(err ?? 'Unknown error');
  const upstream = extractUpstreamError(error);
  const status = normalizeStatus(extractStatus(error), upstream.status);
  const normalizedCode = String(upstream.code || extractString(error.code) || '').trim().toUpperCase();
  const nestedJson = tryExtractNestedJsonErrorMessage(upstream.message || baseMessage);
  const effectiveUpstreamMessage = nestedJson?.message || upstream.message;
  return isClientDisconnectLikeForProjection({
    status,
    code: normalizedCode,
    baseMessage,
    upstreamMessage: upstream.message,
    effectiveUpstreamMessage,
  });
}

function isClientDisconnectLikeForProjection(args: {
  status: number;
  code: string;
  baseMessage: string;
  upstreamMessage?: string;
  effectiveUpstreamMessage?: string;
}): boolean {
  const hints = [args.baseMessage, args.upstreamMessage, args.effectiveUpstreamMessage]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());
  if (args.code === CLIENT_DISCONNECT_PUBLIC_CODE) {
    return true;
  }
  if (hints.some((hint) => hint.includes('client_disconnected') || hint.includes('client disconnected'))) {
    return true;
  }
  if (args.status === 499 || args.code === 'HTTP_499') {
    return hints.some((hint) => hint.includes('client abort request') || hint.includes('client closed request'));
  }
  return hints.some((hint) => hint.includes('client abort request') || hint.includes('client closed request'));
}

export function project_error_err_06_client_from_error_err_05_execution_decision(
  decision: ErrorErr05ExecutionDecision
): ErrorErr06ClientProjected {
  if (!callerMayProject(decision)) {
    throw new EarlyProjectionBlockedError(decision);
  }
  return mapErrorToHttp(decision);
}

export function projectSseErrorEventPayload(args: {
  requestId: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}): SseErrorEventPayload {
  return projectSseErrorEventPayloadNative({
    requestId: args.requestId,
    status: args.status,
    message: args.message,
    code: args.code,
    error: args.error,
  }) as SseErrorEventPayload;
}

export function buildSseErrorEventFrame(args: {
  requestId: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}): { payload: SseErrorEventPayload; frame: string } {
  const payload = projectSseErrorEventPayload(args);
  return {
    payload,
    frame: `event: error\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}


export function mapErrorToPublicLogSummary(error: unknown, fallback?: string): string {
  let projected: HttpErrorPayload;
  try {
    projected = mapErrorToHttp(error);
  } catch (err) {
    if (isClientDisconnectHttpProjectionSentinel(err)) {
      return 'client_disconnect=true request_aborted_by_client';
    }
    throw err;
  }
  const message = projected.body.error.message;
  if (projected.body.error.code === 'upstream_error' && message === 'Upstream provider error') {
    const internalCode = projected.body.error.internalCode;
    return internalCode ? `${message} (internal: ${internalCode})` : (message || 'Upstream provider error');
  }
  if (projected.body.error.internalCode) {
    return message || projected.body.error.internalCode;
  }
  if (
    fallback !== undefined
    && projected.status !== 401
    && projected.status !== 403
    && projected.status !== 429
    && !projected.body.error.upstream_status
  ) {
    return fallback;
  }
  return message || fallback || 'Upstream provider error';
}

function extractStatus(err: RawErrorPayload): number | undefined {
  if (typeof err?.status === 'number') {
    return err.status;
  }
  if (typeof err?.statusCode === 'number') {
    return err.statusCode;
  }
  if (typeof err?.details?.status === 'number') {
    return err.details.status;
  }
  try {
    const msg = String(err?.message || err || '');
    const m = msg.match(/HTTP\s+(\d{3})/i);
    if (m) {
      return parseInt(m[1], 10);
    }
  } catch {
    /* ignore parse errors */
  }
  return undefined;
}

function extractRequestId(err: RawErrorPayload): string | undefined {
  if (typeof err?.requestId === 'string') {
    return err.requestId;
  }
  if (typeof err?.request_id === 'string') {
    return err.request_id;
  }
  if (typeof err?.details?.requestId === 'string') {
    return err.details.requestId;
  }
  if (typeof err?.details?.request_id === 'string') {
    return err.details.request_id;
  }
  return undefined;
}

function extractUpstreamError(err: RawErrorPayload): {
  code?: string;
  message?: string;
  status?: number;
  providerKey?: string;
} {
  const details = err?.details || {};
  const responseError = err?.response?.data?.error;
  return {
    code: extractString(responseError?.code) || extractString(details?.upstreamCode) || extractString(err?.upstreamCode),
    message: extractString(responseError?.message) || extractString(details?.upstreamMessage) || extractString(err?.upstreamMessage),
    status: typeof responseError?.status === 'number' ? responseError.status : undefined,
    providerKey: extractString(details?.providerKey)
  };
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sanitizePublicErrorDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowedTopLevelKeys = new Set([
    'candidateProviderCount',
    'candidateProviderKeys',
    'unavailableProviders',
    'recoverableCooldownHints',
    'minRecoverableCooldownMs',
    'status',
    'statusCode',
    'code',
    'providerKey',
    'providerType',
    'routeName',
    'endpoint',
    'retryable',
    'upstreamCode',
    'upstreamMessage',
    'validationReason',
    'validationMessage',
    'missingFields'
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key.startsWith('__')) {
      continue;
    }
    if (!allowedTopLevelKeys.has(key)) {
      continue;
    }
    sanitized[key] = sanitizePublicErrorDetailValue(key, entry);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizePublicErrorDetailValue(key: string, value: unknown): unknown {
  switch (key) {
    case 'candidateProviderKeys':
      return normalizeStringArray(value) ?? [];
    case 'recoverableCooldownHints':
      return sanitizeRecoverableCooldownHints(value);
    case 'unavailableProviders':
      return sanitizeUnavailableProviders(value);
    case 'missingFields':
      return normalizeStringArray(value) ?? [];
    case 'status':
    case 'statusCode':
    case 'minRecoverableCooldownMs':
      return typeof value === 'number' ? value : undefined;
    case 'retryable':
      return typeof value === 'boolean' ? value : undefined;
    default:
      return value;
  }
}

function sanitizeRecoverableCooldownHints(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const providerKey = extractString(record.providerKey);
      const source = extractString(record.source);
      const waitMs = typeof record.waitMs === 'number' ? record.waitMs : undefined;
      return {
        ...(providerKey ? { providerKey } : {}),
        ...(typeof waitMs === 'number' ? { waitMs } : {}),
        ...(source ? { source } : {})
      };
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null && Object.keys(entry).length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeUnavailableProviders(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => sanitizeUnavailableProvider(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined && Object.keys(entry).length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeUnavailableProvider(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const providerKey = extractString(record.providerKey);
  const reason = extractString(record.reason);
  const reasons = sanitizeUnavailableProviderReasons(record.reasons);
  const health = sanitizeUnavailableProviderHealth(record.health);
  const result: Record<string, unknown> = {
    ...(providerKey ? { providerKey } : {}),
    ...(reason ? { reason } : {}),
    ...(reasons ? { reasons } : {}),
    ...(health ? { health } : {})
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeUnavailableProviderReasons(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const type = extractString(record.type);
      const reason = extractString(record.reason);
      const waitMs = typeof record.waitMs === 'number' ? record.waitMs : undefined;
      const until = typeof record.until === 'number' ? record.until : undefined;
      const cooldownUntil = typeof record.cooldownUntil === 'number' ? record.cooldownUntil : undefined;
      const blacklistUntil = typeof record.blacklistUntil === 'number' ? record.blacklistUntil : undefined;
      const cooldownKeepsPool = typeof record.cooldownKeepsPool === 'boolean' ? record.cooldownKeepsPool : undefined;
      const state = sanitizeUnavailableProviderHealth(record.state);
      const item: Record<string, unknown> = {
        ...(type ? { type } : {}),
        ...(reason ? { reason } : {}),
        ...(typeof waitMs === 'number' ? { waitMs } : {}),
        ...(typeof until === 'number' ? { until } : {}),
        ...(typeof cooldownUntil === 'number' ? { cooldownUntil } : {}),
        ...(typeof blacklistUntil === 'number' ? { blacklistUntil } : {}),
        ...(typeof cooldownKeepsPool === 'boolean' ? { cooldownKeepsPool } : {}),
        ...(state ? { state } : {})
      };
      return Object.keys(item).length > 0 ? item : null;
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeUnavailableProviderHealth(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const providerKey = extractString(record.providerKey);
  const state = extractString(record.state);
  const reason = extractString(record.reason);
  const failureCount =
    typeof record.failureCount === 'number'
      ? record.failureCount
      : typeof record.failure_count === 'number'
        ? record.failure_count
        : undefined;
  const cooldownExpiresAt = typeof record.cooldownExpiresAt === 'number' ? record.cooldownExpiresAt : undefined;
  const lastFailureAt = typeof record.lastFailureAt === 'number' ? record.lastFailureAt : undefined;
  const consecutiveHttp502Failures =
    typeof record.consecutiveHttp502Failures === 'number' ? record.consecutiveHttp502Failures : undefined;
  const consecutiveHttp429Failures =
    typeof record.consecutiveHttp429Failures === 'number' ? record.consecutiveHttp429Failures : undefined;
  const http429CooldownCycles =
    typeof record.http429CooldownCycles === 'number' ? record.http429CooldownCycles : undefined;
  if (providerKey) sanitized.providerKey = providerKey;
  if (state) sanitized.state = state;
  if (reason) sanitized.reason = reason;
  if (typeof failureCount === 'number') sanitized.failureCount = failureCount;
  if (typeof cooldownExpiresAt === 'number') sanitized.cooldownExpiresAt = cooldownExpiresAt;
  if (typeof lastFailureAt === 'number') sanitized.lastFailureAt = lastFailureAt;
  if (typeof consecutiveHttp502Failures === 'number') sanitized.consecutiveHttp502Failures = consecutiveHttp502Failures;
  if (typeof consecutiveHttp429Failures === 'number') sanitized.consecutiveHttp429Failures = consecutiveHttp429Failures;
  if (typeof http429CooldownCycles === 'number') sanitized.http429CooldownCycles = http429CooldownCycles;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length ? normalized : undefined;
}

function normalizeStatus(primary?: number, secondary?: number): number {
  if (typeof primary === 'number' && primary >= 100) {
    return primary;
  }
  if (typeof secondary === 'number' && secondary >= 100) {
    return secondary;
  }
  return 502;
}

function formatPayload(status: number, body: HttpErrorPayload['body']['error']): HttpErrorPayload {
  return { status, body: { error: body } };
}

function sanitizePublicRequestId(value?: string): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return undefined;
  }
  const routed = raw.match(/^(openai-(?:responses|chat|messages)-)(.+?)(-\d{8}T\d{9}-\d+-\d+)$/);
  if (routed) {
    return `${routed[1]}provider${routed[3]}`;
  }
  return raw;
}

function normalizeErrorPayload(err: unknown): RawErrorPayload {
  if (err && typeof err === 'object') {
    return err as RawErrorPayload;
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err ?? 'Unknown error') };
}

export default { mapErrorToHttp, projectSseErrorEventPayload };
