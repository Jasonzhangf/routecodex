import type { ProviderError } from '../../../providers/core/api/provider-types.js';

const NETWORK_ERROR_CODE_SET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED'
]);

export function isClientDisconnectAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  if (code === 'CLIENT_DISCONNECTED') {
    return true;
  }
  const name = typeof err.name === 'string' ? err.name.trim() : '';
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('client_disconnected') || message.includes('client disconnected')) {
    return true;
  }
  if (name === 'AbortError' && (message.includes('client_request_aborted') || message.includes('client_response_closed') || message.includes('client_timeout_hint_expired'))) {
    return true;
  }
  const cause = err.cause;
  if (cause && cause !== error) {
    return isClientDisconnectAbortError(cause);
  }
  return false;
}

export function hasVirtualRouterSeriesCooldown(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') {
    return false;
  }
  const seriesDetail = (details as { virtualRouterSeriesCooldown?: unknown }).virtualRouterSeriesCooldown;
  if (!seriesDetail || typeof seriesDetail !== 'object') {
    return false;
  }
  const record = seriesDetail as {
    cooldownMs?: unknown;
    source?: unknown;
    quotaResetDelay?: unknown;
  };
  const cooldownMs = typeof record.cooldownMs === 'number' ? record.cooldownMs : undefined;
  if (!cooldownMs || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return false;
  }
  const source = typeof record.source === 'string' ? record.source.trim().toLowerCase() : undefined;
  const hasQuotaHint = source === 'quota_reset_delay' || typeof record.quotaResetDelay === 'string';
  return hasQuotaHint;
}

export function isNetworkTransportError(error: unknown): boolean {
  if (isClientDisconnectAbortError(error)) {
    return false;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  if (code && NETWORK_ERROR_CODE_SET.has(code)) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    return true;
  }
  const hints = [
    'fetch failed',
    'network timeout',
    'socket hang up',
    'client network socket disconnected',
    'tls handshake timeout',
    'unable to verify the first certificate',
    'network error',
    'temporarily unreachable'
  ];
  return hints.some((hint) => message.includes(hint));
}

export function shouldRetryProviderError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if (isClientDisconnectAbortError(error)) {
    return false;
  }
  const status = extractErrorStatusCode(error);
  // Deterministic context overflow must fail fast for the current request payload.
  // Replaying the same oversized prompt across providers in the same pool creates
  // retry storms and hides the real issue (continuation/state restore failed).
  if (isPromptTooLongError(error)) {
    return false;
  }
  // virtualRouterSeriesCooldown 表示 provider 已经把 alias 从池子里拉黑，需要切换到下一位。
  // 这类错误仍然属于「可恢复」，因为虚拟路由会根据 cooldown 信息选择新的目标。
  if (hasVirtualRouterSeriesCooldown(error)) {
    return true;
  }
  // Deterministic request-shape validation errors (especially malformed tools/input schema)
  // must not be retried; repeated retries with the same payload only create retry storms.
  if (isDeterministicInvalidRequestError(error, status)) {
    return false;
  }
  if (status === 401 || status === 429 || status === 413 || status === 408 || status === 425) {
    return true;
  }
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  const providerError = error as ProviderError;
  if (providerError.retryable === true) {
    return true;
  }
  if (providerError.retryable === false) {
    return false;
  }
  // iFlow 业务错误 514(model error) 多为上游瞬态失败，允许虚拟路由切换候选继续执行。
  if (isIflowModelError(error)) {
    return true;
  }
  if (isNetworkTransportError(error)) {
    return true;
  }
  return false;
}

function isIflowModelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    message?: unknown;
    upstreamMessage?: unknown;
    response?: unknown;
    details?: unknown;
    providerFamily?: unknown;
    providerId?: unknown;
  };

  const providerHint = String(record.providerFamily || record.providerId || '').toLowerCase();

  const messages: string[] = [];
  if (typeof record.message === 'string' && record.message.trim()) {
    messages.push(record.message);
  }
  if (typeof record.upstreamMessage === 'string' && record.upstreamMessage.trim()) {
    messages.push(record.upstreamMessage);
  }

  const details = record.details;
  if (details && typeof details === 'object') {
    const detailMessage = (details as { upstreamMessage?: unknown }).upstreamMessage;
    if (typeof detailMessage === 'string' && detailMessage.trim()) {
      messages.push(detailMessage);
    }
  }

  const response = record.response;
  if (response && typeof response === 'object') {
    const responseData = (response as { data?: unknown }).data;
    if (responseData && typeof responseData === 'object') {
      const err = (responseData as { error?: unknown }).error;
      if (err && typeof err === 'object') {
        const code = (err as { code?: unknown }).code;
        const message = (err as { message?: unknown }).message;
        if (typeof code === 'string' && code.trim()) {
          messages.push(code);
        }
        if (typeof code === 'number' && Number.isFinite(code)) {
          messages.push(String(code));
        }
        if (typeof message === 'string' && message.trim()) {
          messages.push(message);
        }
      }
    }
  }

  const combined = messages.join(' | ').toLowerCase();
  if (!combined) {
    return false;
  }

  const looksIflow514 =
    (combined.includes('iflow business error (514)') || combined.includes('error_code":514') || combined.includes('code":"514"') || combined.includes('code:514')) &&
    combined.includes('model error');

  if (!looksIflow514) {
    return false;
  }

  return providerHint ? providerHint.includes('iflow') : true;
}

type WaitBeforeRetryOptions = {
  attempt?: number;
  signal?: AbortSignal;
};

function readNestedProviderError(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const nested = (data as { error?: unknown }).error;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

function isDeterministicInvalidRequestError(error: unknown, statusHint?: number): boolean {
  const status = typeof statusHint === 'number' ? statusHint : extractErrorStatusCode(error);
  if (status !== 400) {
    return false;
  }
  const nested = readNestedProviderError(error);
  const code = String(
    (error as { code?: unknown })?.code ??
      (nested?.code as unknown) ??
      ''
  )
    .trim()
    .toLowerCase();
  const type = String(
    (error as { type?: unknown })?.type ??
      (nested?.type as unknown) ??
      ''
  )
    .trim()
    .toLowerCase();
  const param = String((nested?.param as unknown) ?? '').trim().toLowerCase();
  const messageParts = [
    (error as { message?: unknown })?.message,
    nested?.message
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());
  const message = messageParts.join(' | ');

  if (param.startsWith('tools.') || param.startsWith('messages.') || param.startsWith('input.')) {
    return true;
  }
  if (type === 'invalid_request_error') {
    return true;
  }
  if (type.startsWith('invalid_') || code.startsWith('invalid_')) {
    return true;
  }
  if (message.includes('invalid') && !message.includes('temporar')) {
    return true;
  }
  return false;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRetryAfterHeaderSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as {
    response?: { headers?: Record<string, unknown> };
    details?: { response?: { headers?: Record<string, unknown> } };
  };
  const headers =
    (record.response && typeof record.response === 'object' && record.response.headers && typeof record.response.headers === 'object'
      ? record.response.headers
      : undefined)
    ?? (record.details &&
      typeof record.details === 'object' &&
      record.details.response &&
      typeof record.details.response === 'object' &&
      record.details.response.headers &&
      typeof record.details.response.headers === 'object'
      ? record.details.response.headers
      : undefined);
  if (!headers) {
    return undefined;
  }
  const retryAfterRaw =
    headers['retry-after']
    ?? headers['Retry-After']
    ?? headers['retry_after']
    ?? headers['Retry_After'];
  if (typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) && retryAfterRaw > 0) {
    return retryAfterRaw;
  }
  if (typeof retryAfterRaw === 'string') {
    const trimmed = retryAfterRaw.trim();
    const asSeconds = Number.parseFloat(trimmed);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      return asSeconds;
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
      const deltaSeconds = Math.ceil((parsedDate - Date.now()) / 1000);
      if (deltaSeconds > 0) {
        return deltaSeconds;
      }
    }
  }
  return undefined;
}

export function computeRetryDelayMs(error: unknown, options?: WaitBeforeRetryOptions): number {
  const status = extractErrorStatusCode(error);
  const attemptRaw = typeof options?.attempt === 'number' && Number.isFinite(options.attempt) ? options.attempt : 1;
  const attempt = Math.max(1, Math.floor(attemptRaw));
  if (status === 429) {
    const baseMs = parsePositiveInt(
      process.env.ROUTECODEX_429_BACKOFF_BASE_MS || process.env.RCC_429_BACKOFF_BASE_MS,
      1000
    );
    const maxMs = parsePositiveInt(
      process.env.ROUTECODEX_429_BACKOFF_MAX_MS || process.env.RCC_429_BACKOFF_MAX_MS,
      30000
    );
    const exponentialMs = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    const retryAfterSeconds = readRetryAfterHeaderSeconds(error);
    const retryAfterMs =
      typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(maxMs, Math.round(retryAfterSeconds * 1000))
        : 0;
    return Math.max(exponentialMs, retryAfterMs);
  }
  if (isNetworkTransportError(error)) {
    const networkBaseMs = parsePositiveInt(
      process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_BASE_MS || process.env.RCC_NETWORK_RETRY_BACKOFF_BASE_MS,
      500
    );
    const networkMaxMs = parsePositiveInt(
      process.env.ROUTECODEX_NETWORK_RETRY_BACKOFF_MAX_MS || process.env.RCC_NETWORK_RETRY_BACKOFF_MAX_MS,
      12000
    );
    return Math.min(networkMaxMs, networkBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
  }
  // Single-provider pools can only retry the same provider key; enforce exponential
  // backoff to avoid retry storms when upstream is temporarily or deterministically failing.
  // 2026-04: under provider-switch storms, 800ms base was still too aggressive at scale.
  // Raise default generic backoff so switch/failover traffic naturally slows down.
  const genericDefaultBaseMs = process.env.NODE_ENV === 'test' ? 800 : 2000;
  const genericDefaultMaxMs = process.env.NODE_ENV === 'test' ? 15000 : 60000;
  const genericBaseMs = parsePositiveInt(
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS || process.env.RCC_PROVIDER_RETRY_BACKOFF_BASE_MS,
    genericDefaultBaseMs
  );
  const genericMaxMs = parsePositiveInt(
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS || process.env.RCC_PROVIDER_RETRY_BACKOFF_MAX_MS,
    genericDefaultMaxMs
  );
  return Math.min(genericMaxMs, genericBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
}

export async function waitBeforeRetry(error: unknown, options?: WaitBeforeRetryOptions): Promise<number> {
  const delayMs = computeRetryDelayMs(error, options);
  const signal = options?.signal;
  if (signal?.aborted) {
    const reason = (signal as { reason?: unknown }).reason;
    throw reason instanceof Error ? reason : Object.assign(new Error(String(reason ?? 'CLIENT_DISCONNECTED')), {
      code: 'CLIENT_DISCONNECTED',
      name: 'AbortError'
    });
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, delayMs);
    const onAbort = () => {
      cleanup();
      const reason = (signal as { reason?: unknown }).reason;
      reject(
        reason instanceof Error
          ? reason
          : Object.assign(new Error(String(reason ?? 'CLIENT_DISCONNECTED')), {
              code: 'CLIENT_DISCONNECTED',
              name: 'AbortError'
            })
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort as EventListener);
      } catch {
        // ignore cleanup errors
      }
    };
    try {
      signal?.addEventListener?.('abort', onAbort as EventListener, { once: true } as AddEventListenerOptions);
    } catch {
      // ignore listener registration failure and rely on timeout
    }
  });
  return delayMs;
}

export function isPromptTooLongError(error: unknown): boolean {
  const status = extractErrorStatusCode(error);
  // Most upstreams return 400 for context overflow; keep this narrow to avoid retries on generic 400s.
  // Some error shims only expose the message (or nest status inside response.data.error.status),
  // so allow missing status when the message is a strong match.
  if (status !== undefined && status !== 400) {
    return false;
  }
  const explicitCode = (error as { code?: unknown }).code;
  if (typeof explicitCode === 'string' && explicitCode.trim().toLowerCase() === 'context_length_exceeded') {
    return true;
  }
  const messages: string[] = [];
  const rawMessage = (error as { message?: unknown }).message;
  if (typeof rawMessage === 'string' && rawMessage.trim()) {
    messages.push(rawMessage);
  }
  const upstreamMessage = (error as { upstreamMessage?: unknown }).upstreamMessage;
  if (typeof upstreamMessage === 'string' && upstreamMessage.trim()) {
    messages.push(upstreamMessage);
  }
  const details = (error as { details?: unknown }).details;
  if (details && typeof details === 'object') {
    const msg = (details as { upstreamMessage?: unknown }).upstreamMessage;
    if (typeof msg === 'string' && msg.trim()) {
      messages.push(msg);
    }
  }
  const response = (error as { response?: unknown }).response;
  if (response && typeof response === 'object') {
    const data = (response as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const err = (data as { error?: unknown }).error;
      if (err && typeof err === 'object') {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === 'string' && msg.trim()) {
          messages.push(msg);
        }
      }
    }
  }
  const combined = messages.join(' | ').toLowerCase();
  if (!combined) {
    return false;
  }
  return (
    combined.includes('prompt is too long') ||
    combined.includes('maximum context') ||
    combined.includes('max context') ||
    combined.includes('context length') ||
    combined.includes('context_window_exceeded') ||
    combined.includes('token limit') ||
    combined.includes('too many tokens')
  );
}

export function extractErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const statusCandidates: Array<number | undefined> = [];
  const directStatus = (error as { statusCode?: unknown }).statusCode;
  if (typeof directStatus === 'number') {
    statusCandidates.push(directStatus);
  }
  const secondaryStatus = (error as { status?: unknown }).status;
  if (typeof secondaryStatus === 'number') {
    statusCandidates.push(secondaryStatus);
  }
  const detailStatus = (error as { details?: unknown }).details;
  if (detailStatus && typeof detailStatus === 'object') {
    const nestedStatus = (detailStatus as { status?: unknown }).status;
    if (typeof nestedStatus === 'number') {
      statusCandidates.push(nestedStatus);
    }
    const upstreamStatus = (detailStatus as { upstreamStatus?: unknown }).upstreamStatus;
    if (typeof upstreamStatus === 'number') {
      statusCandidates.push(upstreamStatus);
    }
    const upstreamStatusSnake = (detailStatus as { upstream_status?: unknown }).upstream_status;
    if (typeof upstreamStatusSnake === 'number') {
      statusCandidates.push(upstreamStatusSnake);
    }
  }
  const response = (error as { response?: unknown }).response;
  if (response && typeof response === 'object') {
    const respStatus = (response as { status?: unknown }).status;
    if (typeof respStatus === 'number') {
      statusCandidates.push(respStatus);
    }
    const respStatusCode = (response as { statusCode?: unknown }).statusCode;
    if (typeof respStatusCode === 'number') {
      statusCandidates.push(respStatusCode);
    }
    const data = (response as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const errNode = (data as { error?: unknown }).error;
      if (errNode && typeof errNode === 'object') {
        const nested = (errNode as { status?: unknown }).status;
        if (typeof nested === 'number') {
          statusCandidates.push(nested);
        }
      }
    }
  }
  const explicit = statusCandidates.find((candidate): candidate is number => typeof candidate === 'number');
  if (typeof explicit === 'number') {
    return explicit;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    const match = message.match(/HTTP\s+(\d{3})/i);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function describeRetryReason(error: unknown): string {
  if (!error) {
    return 'unknown';
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}
