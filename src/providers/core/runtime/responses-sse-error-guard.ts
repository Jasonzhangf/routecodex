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

function readErrorPayload(data: UnknownRecord | undefined): { code?: string; message?: string } {
  if (!data) {
    return {};
  }
  const nestedError = asRecord(data.error);
  const response = asRecord(data.response);
  const responseError = asRecord(response.error);
  return {
    code: pickString(data.code) ?? pickString(nestedError.code) ?? pickString(responseError.code),
    message: pickString(data.message) ?? pickString(nestedError.message) ?? pickString(responseError.message)
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
}): ResponsesSseProviderError {
  const error = new Error(args.message) as ResponsesSseProviderError;
  error.statusCode = 429;
  error.status = 429;
  error.code = 'PROVIDER_TRAFFIC_SATURATED';
  if (args.code) {
    error.upstreamCode = args.code;
  }
  error.retryable = true;
  error.requestExecutorProviderErrorStage = 'provider.http';
  return error;
}

export function inspectResponsesSseBlockForProviderRateLimit(block: string): { code?: string; message: string } | null {
  const parsed = parseResponsesSseFrame(block);
  const payload = readErrorPayload(parsed.data);
  const type = pickString(parsed.data?.type);
  if (
    parsed.eventName !== 'error'
    && parsed.eventName !== 'response.failed'
    && type !== 'error'
    && type !== 'response.failed'
  ) {
    return null;
  }
  if (!isResponsesSseRateLimitLike(payload)) {
    return null;
  }
  return {
    message: payload.message ?? 'upstream Responses SSE rate limit error',
    ...(payload.code ? { code: payload.code } : {})
  };
}
