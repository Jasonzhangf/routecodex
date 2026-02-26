/**
 * Executor Module Exports
 *
 * Unified exports for all executor submodules.
 */

// Utilities
export {
  firstNonEmptyString,
  firstFiniteNumber,
  extractStatusCodeFromError,
  resolveBoolFromEnv
} from './utils.js';

// Retry engine
export {
  describeRetryReason,
  shouldRetryProviderError,
  waitBeforeRetry,
  RETRYABLE_SSE_ERROR_CODE_HINTS,
  RETRYABLE_SSE_MESSAGE_HINTS,
  isRetryableSseWrapperError,
  resolveMaxProviderAttempts,
  resolveAntigravityMaxProviderAttempts
} from './retry-engine.js';

// SSE error handling
export {
  type SseWrapperErrorInfo,
  extractSseWrapperError
} from './sse-error-handler.js';

// Antigravity detection
export {
  isAntigravityProviderKey,
  isGoogleAccountVerificationRequiredError,
  isAntigravityReauthRequired403,
  extractRetryErrorSignature,
  shouldRotateAntigravityAliasOnRetry,
  injectAntigravityRetrySignal
} from './antigravity-detector.js';

// Usage aggregation
export {
  type UsageMetrics,
  extractUsageFromResult,
  normalizeUsage,
  mergeUsageMetrics,
  buildUsageLogText
} from './usage-aggregator.js';

// Environment configuration
export {
  isUsageLoggingEnabled,
  isVerboseErrorLoggingEnabled
} from './env-config.js';
