import type {
  RequestLocalTransientRetryTracker,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import { normalizeCodeKey } from './request-executor-error-shared.js';

function normalizeRetryErrorFingerprint(retryError: RetryErrorSnapshot): string {
  const statusPart = typeof retryError.statusCode === 'number' ? `status:${retryError.statusCode}` : 'status:none';
  const errorPart = normalizeCodeKey(retryError.errorCode) ?? 'error:none';
  const upstreamPart = normalizeCodeKey(retryError.upstreamCode) ?? 'upstream:none';
  return `${statusPart}|${errorPart}|${upstreamPart}`;
}

export function createRequestLocalTransientRetryTracker(): RequestLocalTransientRetryTracker {
  const counts = new Map<string, number>();
  return {
    observe(args: { providerKey?: string; retryError: RetryErrorSnapshot }): number {
      const providerKey =
        typeof args.providerKey === 'string' && args.providerKey.trim()
          ? args.providerKey.trim()
          : 'unknown-provider';
      const key = `${providerKey}|${normalizeRetryErrorFingerprint(args.retryError)}`;
      const nextCount = (counts.get(key) ?? 0) + 1;
      counts.set(key, nextCount);
      return nextCount;
    }
  };
}
