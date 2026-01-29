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
  // Deterministic context overflow: retrying the *same* model will keep failing,
  // but a different model/provider in the same route pool might accept it.
  // This matches the virtual-router strategy: if a target is over its context window,
  // switch to the next candidate before giving up.
  if (isPromptTooLongError(error)) {
    return true;
  }
  // virtualRouterSeriesCooldown 表示 provider 已经把 alias 从池子里拉黑，需要切换到下一位。
  // 这类错误仍然属于「可恢复」，因为虚拟路由会根据 cooldown 信息选择新的目标。
  if (hasVirtualRouterSeriesCooldown(error)) {
    return true;
  }
  const providerError = error as ProviderError;
  if (providerError.retryable === true) {
    return true;
  }
  if (isNetworkTransportError(error)) {
    return true;
  }
  const status = extractErrorStatusCode(error);
  if (status === 429 || status === 408 || status === 425) {
    return true;
  }
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  return false;
}

export async function waitBeforeRetry(error: unknown): Promise<void> {
  if (!isNetworkTransportError(error)) {
    return;
  }
  const delayMs = 500;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isPromptTooLongError(error: unknown): boolean {
  const status = extractErrorStatusCode(error);
  // Most upstreams return 400 for context overflow; keep this narrow to avoid retries on generic 400s.
  // Some error shims only expose the message (or nest status inside response.data.error.status),
  // so allow missing status when the message is a strong match.
  if (status !== undefined && status !== 400) {
    return false;
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
