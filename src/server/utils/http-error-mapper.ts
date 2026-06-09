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
      tool_name?: string;
      validation_reason?: string;
      validation_message?: string;
      missing_fields?: string[];
      details?: Record<string, unknown>;
    };
  };
}

export const ERROR_CLIENT_PROJECTION_FEATURE_ID = 'feature_id: error.client_projection';

export type ErrorErr05ExecutionDecision = unknown;
export type ErrorErr06ClientProjected = HttpErrorPayload;

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
};

type RawErrorPayload = {
  message?: string;
  status?: number;
  statusCode?: number;
  requestId?: string;
  request_id?: string;
  code?: string;
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
  if (normalizedCode === 'MALFORMED_REQUEST') {
    return formatPayload(400, {
      message: baseMessage || 'Malformed request',
      code: 'MALFORMED_REQUEST',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
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
      code: upstreamCode || effectiveCode || 'gateway_timeout',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 429) {
    return formatPayload(429, {
      message: 'Rate limited by upstream provider',
      code: upstreamCode || effectiveCode || 'rate_limit',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  if (status === 401 || status === 403) {
    return formatPayload(status, {
      message: 'Upstream authentication failed',
      code: upstreamCode || effectiveCode || 'authentication_error',
      request_id: requestId,
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
    return formatPayload(status, {
      message: 'Upstream rejected the request',
      code: upstreamCode || effectiveCode || 'upstream_client_error',
      request_id: requestId,
      ...validationFields,
      ...detailField
    });
  }

  return formatPayload(502, {
    message: 'Upstream provider error',
    code: upstreamCode || effectiveCode || 'upstream_error',
    request_id: requestId,
    ...validationFields,
    ...detailField
  });
}

export function project_error_err_06_client_from_error_err_05_execution_decision(
  decision: ErrorErr05ExecutionDecision
): ErrorErr06ClientProjected {
  return mapErrorToHttp(decision);
}

export function mapErrorToPublicLogSummary(error: unknown, fallback?: string): string {
  const projected = mapErrorToHttp(error);
  const message = projected.body.error.message;
  if (fallback !== undefined && projected.status !== 401 && projected.status !== 403 && projected.status !== 429) {
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
    code: extractString(responseError?.code) || extractString(details?.upstreamCode),
    message: extractString(responseError?.message) || extractString(details?.upstreamMessage),
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

export default { mapErrorToHttp };
