import type { ProviderError } from '../../../providers/core/api/provider-types.js';

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

export function shouldRetryProviderError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
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
  const status = extractErrorStatusCode(error);
  if (status === 429 || status === 408 || status === 425) {
    return true;
  }
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  return false;
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
