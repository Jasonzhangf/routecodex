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
    };
  };
}

type RawErrorDetails = {
  status?: number;
  requestId?: string;
  request_id?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  upstreamCode?: string;
  upstreamMessage?: string;
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

export function mapErrorToHttp(err: unknown): HttpErrorPayload {
  const error = normalizeErrorPayload(err);
  const baseMessage = typeof error.message === 'string' ? error.message : String(err ?? 'Unknown error');
  const statusFromErr = extractStatus(error);
  const upstream = extractUpstreamError(error);
  const status = normalizeStatus(statusFromErr, upstream.status);
  const requestId = extractRequestId(error);
  const providerKey =
    extractString(error.providerKey) ||
    extractString(error.details?.providerKey) ||
    extractString(upstream.providerKey);
  const providerType = extractString(error.providerType) || extractString(error.details?.providerType);
  const routeName = extractString(error.routeName) || extractString(error.details?.routeName);
  const upstreamCode = upstream.code;
  const upstreamMessage = upstream.message;
  const effectiveCode = upstream.code || extractString(error.code) || 'upstream_error';

  const timeoutHint = `${baseMessage} ${extractString(error.code) || ''} ${extractString(upstreamCode) || ''}`.toLowerCase();
  if (
    timeoutHint.includes('timeout') ||
    timeoutHint.includes('upstream_stream_timeout') ||
    timeoutHint.includes('upstream_stream_idle_timeout') ||
    timeoutHint.includes('upstream_headers_timeout')
  ) {
    return formatPayload(504, {
      message: upstreamMessage || baseMessage || 'Upstream request timed out',
      code: upstreamCode || effectiveCode || 'gateway_timeout',
      request_id: requestId,
      provider_key: providerKey,
      route_name: routeName,
      provider_type: providerType,
      upstream_status: upstream.status,
      upstream_code: upstreamCode,
      upstream_message: upstreamMessage
    });
  }

  if (status === 429) {
    return formatPayload(429, {
      message: 'Rate limited by upstream provider',
      code: upstreamCode || effectiveCode || 'rate_limit',
      request_id: requestId,
      provider_key: providerKey,
      route_name: routeName,
      provider_type: providerType,
      upstream_status: upstream.status,
      upstream_code: upstreamCode,
      upstream_message: upstreamMessage
    });
  }

  if (status === 401 || status === 403) {
    return formatPayload(status, {
      message: upstreamMessage || 'Upstream authentication failed',
      code: upstreamCode || effectiveCode || 'authentication_error',
      request_id: requestId,
      provider_key: providerKey,
      route_name: routeName,
      provider_type: providerType,
      upstream_status: upstream.status,
      upstream_code: upstreamCode,
      upstream_message: upstreamMessage
    });
  }

  if (status >= 400 && status < 500) {
    return formatPayload(status, {
      message: upstreamMessage || baseMessage || 'Upstream rejected the request',
      code: upstreamCode || effectiveCode || 'upstream_client_error',
      request_id: requestId,
      provider_key: providerKey,
      route_name: routeName,
      provider_type: providerType,
      upstream_status: upstream.status,
      upstream_code: upstreamCode,
      upstream_message: upstreamMessage
    });
  }

  return formatPayload(502, {
    message: upstreamMessage || baseMessage || 'Upstream provider error',
    code: upstreamCode || effectiveCode || 'upstream_error',
    request_id: requestId,
    provider_key: providerKey,
    route_name: routeName,
    provider_type: providerType,
    upstream_status: upstream.status,
    upstream_code: upstreamCode,
    upstream_message: upstreamMessage
  });
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
