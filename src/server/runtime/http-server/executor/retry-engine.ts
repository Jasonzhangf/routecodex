/**
 * Retry Engine for request-executor
 *
 * Handles retry logic, backoff, and retryable error detection.
 */

import {
  describeRetryReason,
  isPromptTooLongError,
  shouldRetryProviderError,
  waitBeforeRetry
} from '../executor-provider.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';

// Re-export for backward compatibility
export {
  describeRetryReason,
  isPromptTooLongError,
  shouldRetryProviderError,
  waitBeforeRetry
};

// Retryable error detection for SSE responses
export const RETRYABLE_SSE_ERROR_CODE_HINTS = [
  'internal_network_failure',
  'network_error',
  'api_connection_error',
  'service_unavailable',
  'internal_server_error',
  'overloaded_error',
  'rate_limit_error',
  'request_timeout',
  'timeout'
];

export const RETRYABLE_SSE_MESSAGE_HINTS = [
  'internal network failure',
  'network failure',
  'network error',
  'temporarily unavailable',
  'temporarily unreachable',
  'upstream disconnected',
  'connection reset',
  'connection closed',
  'timed out',
  'timeout'
];

/**
 * Check if an SSE error is retryable based on message, error code, or status
 */
export function isRetryableSseWrapperError(
  message: string,
  errorCode?: string,
  status?: number
): boolean {
  const known = normalizeKnownProviderError({
    statusCode: typeof status === 'number' ? status : undefined,
    code: errorCode,
    upstreamCode: errorCode,
    message,
  });
  if (known?.code === '429.2000') {
    return false;
  }
  if (known) {
    if (known.class === 'recoverable') {
      return true;
    }
    if (known.class === 'unrecoverable' || known.class === 'special_400') {
      return false;
    }
  }
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return true;
    }
  }
  const normalizedCode = typeof errorCode === 'string' ? errorCode.trim().toLowerCase() : '';
  if (normalizedCode && RETRYABLE_SSE_ERROR_CODE_HINTS.some((hint) => normalizedCode.includes(hint))) {
    return true;
  }
  const loweredMessage = message.toLowerCase();
  return RETRYABLE_SSE_MESSAGE_HINTS.some((hint) => loweredMessage.includes(hint));
}

/**
 * Resolve maximum provider attempts from environment
 */
export function resolveMaxProviderAttempts(): number {
  const DEFAULT_MAX_PROVIDER_ATTEMPTS = 6;
  const raw = String(
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS || process.env.RCC_MAX_PROVIDER_ATTEMPTS || ''
  )
    .trim()
    .toLowerCase();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const candidate = Number.isFinite(parsed) ? parsed : DEFAULT_MAX_PROVIDER_ATTEMPTS;
  return Math.max(1, Math.min(20, candidate));
}
