type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseResponsesSseFrame(block: string): { eventName?: string; data?: UnknownRecord } {
  const lines = block.split(/\r?\n/);
  const eventName = lines
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .find(Boolean);
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return { eventName };
  }
  try {
    const data = JSON.parse(dataText) as unknown;
    return { eventName, data: asRecord(data) };
  } catch {
    return { eventName };
  }
}

function pickStatusCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const status = Math.floor(value);
    return status >= 100 && status <= 599 ? status : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
  }
  return undefined;
}

function readErrorPayload(data: UnknownRecord | undefined): { code?: string; message?: string; statusCode?: number } {
  if (!data) {
    return {};
  }
  const nestedError = asRecord(data.error);
  const response = asRecord(data.response);
  const responseError = asRecord(response.error);
  return {
    code: pickString(data.code) ?? pickString(nestedError.code) ?? pickString(responseError.code),
    message: pickString(data.message) ?? pickString(nestedError.message) ?? pickString(responseError.message),
    statusCode:
      pickStatusCode(data.status)
      ?? pickStatusCode(data.statusCode)
      ?? pickStatusCode(data.http_status)
      ?? pickStatusCode(nestedError.status)
      ?? pickStatusCode(nestedError.statusCode)
      ?? pickStatusCode(nestedError.http_status)
      ?? pickStatusCode(response.status)
      ?? pickStatusCode(response.statusCode)
      ?? pickStatusCode(responseError.status)
      ?? pickStatusCode(responseError.statusCode)
      ?? pickStatusCode(responseError.http_status)
  };
}

function isResponsesSseRateLimitLike(args: { code?: string; message?: string }): boolean {
  const code = (args.code ?? '').trim().toLowerCase();
  const message = (args.message ?? '').trim().toLowerCase();
  return code === 'rate_limit_error'
    || code === 'provider_traffic_saturated'
    || code === 'http_429'
    || message.includes('concurrency limit exceeded')
    || message.includes('rate limit')
    || message.includes('too many requests');
}

export type ResponsesSseProviderError = Error & {
  statusCode: number;
  status: number;
  code: string;
  upstreamCode?: string;
  retryable: boolean;
  requestExecutorProviderErrorStage: string;
};

export function buildResponsesSseProviderError(args: {
  message: string;
  code?: string;
  statusCode?: number;
}): ResponsesSseProviderError {
  const error = new Error(args.message) as ResponsesSseProviderError;
  const statusCode = pickStatusCode(args.statusCode) ?? inferResponsesSseProviderErrorStatus(args) ?? 502;
  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = statusCode === 429 && isResponsesSseRateLimitLike(args)
    ? 'PROVIDER_TRAFFIC_SATURATED'
    : `HTTP_${statusCode}`;
  if (args.code) {
    error.upstreamCode = args.code;
  }
  error.retryable = true;
  error.requestExecutorProviderErrorStage = 'provider.http';
  return error;
}

function inferResponsesSseProviderErrorStatus(args: { code?: string; message?: string }): number | undefined {
  const code = (args.code ?? '').trim().toLowerCase();
  const message = (args.message ?? '').trim().toLowerCase();
  const numeric = code.match(/(?:^|[^0-9])(\d{3})(?:[^0-9]|$)/)?.[1]
    ?? message.match(/(?:^|[^0-9])(\d{3})(?:[^0-9]|$)/)?.[1];
  if (numeric) {
    const status = Number.parseInt(numeric, 10);
    if (Number.isFinite(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  if (code.includes('quota') || code.includes('billing') || code.includes('balance') || code.includes('payment')
    || message.includes('quota') || message.includes('billing') || message.includes('balance') || message.includes('payment')) {
    return 402;
  }
  if (code.includes('unauthorized') || code.includes('auth') || message.includes('unauthorized') || message.includes('invalid api key')) {
    return 401;
  }
  if (code.includes('forbidden') || message.includes('forbidden') || message.includes('access denied')) {
    return 403;
  }
  if (isResponsesSseRateLimitLike(args)) {
    return 429;
  }
  return undefined;
}

export function buildResponsesSseIncompleteError(message = 'stream closed before response.completed'): ResponsesSseProviderError {
  const error = new Error(message) as ResponsesSseProviderError;
  error.statusCode = 502;
  error.status = 502;
  error.code = 'UPSTREAM_STREAM_INCOMPLETE';
  error.upstreamCode = 'UPSTREAM_STREAM_INCOMPLETE';
  error.retryable = true;
  error.requestExecutorProviderErrorStage = 'provider.responses';
  return error;
}

export function isResponsesSseTerminalBlock(block: string): boolean {
  const parsed = parseResponsesSseFrame(block);
  const type = pickString(parsed.data?.type);
  if (!parsed.data && parsed.eventName === undefined && block
    .split(/\r?\n/)
    .some((line) => line.trim() === 'data: [DONE]')) {
    return true;
  }
  return parsed.eventName === 'response.completed'
    || parsed.eventName === 'response.done'
    || parsed.eventName === 'response.requires_action'
    || type === 'response.completed'
    || type === 'response.done'
    || type === 'response.requires_action';
}

export function isResponsesSseCompletedBlock(block: string): boolean {
  return isResponsesSseTerminalBlock(block);
}

export function inspectResponsesSseBlockForProviderRateLimit(block: string): { code?: string; message: string } | null {
  const failure = inspectResponsesSseBlockForProviderFailure(block);
  if (!failure || !isResponsesSseRateLimitLike(failure)) {
    return null;
  }
  return {
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {})
  };
}

export function inspectResponsesSseBlockForProviderFailure(block: string): { code?: string; message: string; statusCode?: number } | null {
  const parsed = parseResponsesSseFrame(block);
  const payload = readErrorPayload(parsed.data);
  const type = pickString(parsed.data?.type);
  if (parsed.eventName === 'codex.rate_limits') {
    const limitReached = parsed.data?.limit_reached;
    if (limitReached === true || limitReached === 'true') {
      return {
        code: pickString(parsed.data?.code) ?? 'codex.rate_limits',
        message: pickString(parsed.data?.message) ?? 'upstream Responses SSE rate limit reached',
        statusCode: 429
      };
    }
    return null;
  }
  if (
    parsed.eventName !== 'error'
    && parsed.eventName !== 'response.failed'
    && type !== 'error'
    && type !== 'response.failed'
  ) {
    return null;
  }
  const statusCode = payload.statusCode ?? inferResponsesSseProviderErrorStatus(payload);
  const shouldRaiseProviderError = statusCode !== undefined
    && (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 429 || statusCode >= 500);
  if (!shouldRaiseProviderError && !isResponsesSseRateLimitLike(payload)) {
    return null;
  }
  return {
    message: payload.message ?? 'upstream Responses SSE provider error',
    ...(payload.code ? { code: payload.code } : {}),
    ...(statusCode !== undefined ? { statusCode } : {})
  };
}

export function isResponsesSseAdvisoryRateLimitsBlock(block: string): boolean {
  const parsed = parseResponsesSseFrame(block);
  if (parsed.eventName !== 'codex.rate_limits') {
    return false;
  }
  const limitReached = parsed.data?.limit_reached;
  return limitReached !== true && limitReached !== 'true';
}
