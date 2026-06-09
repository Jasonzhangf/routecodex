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
  resolveMaxProviderAttempts
} from './retry-engine.js';

// SSE error handling
export {
  type SseWrapperErrorInfo,
  extractSseWrapperError
} from './sse-error-handler.js';

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

// Failure state
export {
  type RequestExecutorFailureState,
  applyResolveFailureState,
  applySendFailureState
} from './request-executor-failure-state.js';

// Goal state persistence
export {
  asFlatRecord,
  persistGoalStateFromMergedMetadata
} from './goal-state-persistence.js';
