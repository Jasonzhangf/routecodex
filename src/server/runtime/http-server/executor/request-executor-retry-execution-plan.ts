import {
  isHostRequestExecutorErrorStage,
  resolveRequestExecutorProviderErrorClassification,
} from './request-executor-provider-failure.js';
import {
  applyRetryExclusionForCurrentProvider,
  buildProviderRetrySwitchPlan,
  hasAlternativeRouteCandidate,
  isLastAvailableProvider429,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExclusionPlan
} from './request-executor-retry-decision.js';
import {
  resolveProviderRetryBackoffPlan
} from './request-executor-retry-backoff.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export async function resolveProviderRetryExecutionPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  runtimeKey?: string;
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  runtimeManager?: RuntimeManager;
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  status?: number;
  forceExcludeCurrentProviderOnRetry?: boolean;
  abortSignal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<ProviderRetryExecutionPlan> {
  const hostContractFailure = isHostRequestExecutorErrorStage(args.stage ?? 'provider.send');
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  const eligibilityPlan = resolveProviderRetryEligibilityPlan({
    error: args.error,
    retryError: args.retryError,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: args.stage,
    providerKey: args.providerKey,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries
  });
  args.recordAttempt({ error: true });
  if (!eligibilityPlan.shouldRetry) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      holdOnLastAvailable429: false,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }
  const exclusionPlan = hostContractFailure
    ? {
      excludedCurrentProvider: false
    }
    : args.forceExcludeCurrentProviderOnRetry
      ? {
        excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
          providerKey: args.providerKey,
          excludedProviderKeys: args.excludedProviderKeys
        })
      }
      : resolveProviderRetryExclusionPlan({
        providerKey: args.providerKey,
        status: args.status,
        error: args.error,
        classification,
        promptTooLong: Boolean(args.promptTooLong),
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys
      });
  const holdOnLastAvailable429 = isLastAvailableProvider429({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys,
    retryError: args.retryError
  });
  if (
    classification === 'unrecoverable'
    && !exclusionPlan.excludedCurrentProvider
    && (args.error as { retryable?: unknown } | undefined)?.retryable !== true
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }
  const retryBackoffPlan = await resolveProviderRetryBackoffPlan({
    error: args.error,
    retryError: args.retryError,
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    stage: args.stage,
    attempt: args.attempt,
    forceProviderScopedBackoff: exclusionPlan.excludedCurrentProvider,
    forceAttemptScopedBackoff: hostContractFailure && !exclusionPlan.excludedCurrentProvider,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  const retrySwitchPlan = buildProviderRetrySwitchPlan({
    runtimeKey: args.runtimeKey,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
    promptTooLong: args.promptTooLong,
    error: args.error,
    retryError: args.retryError,
    backoffScope: retryBackoffPlan.backoffScope
  });
  if (
    classification === 'unrecoverable'
    && retrySwitchPlan.switchAction === 'exclude_and_reroute'
    && !hasAlternativeRouteCandidate({
      providerKey: args.providerKey,
      routePool: args.routePool,
      excludedProviderKeys: args.excludedProviderKeys
    })
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }
  return {
    shouldRetry: true,
    blockingRecoverable: eligibilityPlan.blockingRecoverable,
    excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
    holdOnLastAvailable429,
    retryBackoffMs: retryBackoffPlan.retryBackoffMs,
    recoverableBackoffMs: retryBackoffPlan.recoverableBackoffMs,
    backoffScope: retryBackoffPlan.backoffScope,
    retrySwitchPlan
  };
}
