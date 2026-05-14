import {
  extractStatusCodeFromError
} from './utils.js';
import type {
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export function truncateReason(reason: string, maxLength = 220): string {
  if (reason.length <= maxLength) {
    return reason;
  }
  return `${reason.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function normalizeCodeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

export function isServerToolFollowupErrorCode(value: unknown): boolean {
  const normalized = normalizeCodeKey(value);
  return Boolean(normalized && normalized.startsWith('SERVERTOOL_'));
}

export function isRequestExecutorProviderErrorStage(value: unknown): value is RequestExecutorProviderErrorStage {
  return (
    value === 'provider.runtime_resolve'
    || value === 'provider.send'
    || value === 'host.response_contract'
    || value === 'provider.followup'
    || value === 'provider.sse_decode'
    || value === 'provider.http'
  );
}

export function isHostRequestExecutorErrorStage(
  stage: RequestExecutorProviderErrorStage
): stage is 'host.response_contract' {
  return stage === 'host.response_contract';
}

export function normalizeRuntimeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function extractRequestExecutorProviderErrorStage(error: unknown): RequestExecutorProviderErrorStage | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as {
    requestExecutorProviderErrorStage?: unknown;
    details?: unknown;
  };
  const directStage = record.requestExecutorProviderErrorStage;
  if (isRequestExecutorProviderErrorStage(directStage)) {
    return directStage;
  }
  const details =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const detailStage =
    details?.requestExecutorProviderErrorStage
    ?? details?.source;
  return isRequestExecutorProviderErrorStage(detailStage) ? detailStage : undefined;
}

export function deriveRetryErrorStatusCode(error: unknown, retryError: RetryErrorSnapshot): number | undefined {
  return typeof retryError.statusCode === 'number'
    ? retryError.statusCode
    : extractStatusCodeFromError(error);
}
