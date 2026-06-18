import {
  isHostRequestExecutorErrorStage,
  resolveRequestExecutorProviderErrorClassification,
  shouldApplyProviderTransportBackoff,
} from './request-executor-provider-failure.js';
import {
  shouldCancelUnrecoverableRerouteWithoutAlternative,
  shouldDirectReturnUnrecoverableWithoutForcedExclusion,
  shouldRerouteTerminalPeriodicRecovery,
  shouldRerouteTerminalUnrecoverableProviderFailure,
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  resolveRequestExecutorNativeRetryPolicy,
} from './request-executor-native-retry-policy.js';
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
  RequestLocalTransientRetryTracker,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export const ERROR_EXECUTION_DECISION_CONSUMER_FEATURE_ID = 'feature_id: error.execution_decision_consumer';

export type RequestExecutorErrorErr04RouterPolicyEnvelope = {
// topology-node: ErrorErr04RouterPolicyApplied (executor-side envelope alias)
  retryExecutionPlan: ProviderRetryExecutionPlan;
};

export type ErrorErr05ExecutionDecision = ProviderRetryExecutionPlan;

export function consume_error_err_05_execution_decision_from_error_err_04_router_policy(
  applied: RequestExecutorErrorErr04RouterPolicyEnvelope
): ErrorErr05ExecutionDecision {
  return applied.retryExecutionPlan;
}

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
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
  isStreamingRequest?: boolean;
  providerOwnedContinuation?: boolean;
  transientRetryTracker?: RequestLocalTransientRetryTracker;
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

  const baseExclusionPlan = hostContractFailure
    ? { excludedCurrentProvider: false }
    : resolveProviderRetryExclusionPlan({
        providerKey: args.providerKey,
        status: args.retryError.statusCode ?? args.status,
        error: args.error,
        classification,
        attempt: args.attempt,
        promptTooLong: Boolean(args.promptTooLong),
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys,
        retryError: args.retryError,
        transientRetryTracker: args.transientRetryTracker
      });
  if (!classification) {
    throw new Error('[request-executor] provider failure classification missing');
  }
  const nativeExecutionPolicy = resolveRequestExecutorNativeRetryPolicy({
    classification,
    isStreamingRequest: args.isStreamingRequest === true,
    hostContractFailure,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry === true,
    promptTooLong: args.promptTooLong === true,
    existingExclusion: baseExclusionPlan.excludedCurrentProvider,
  });
  const exclusionPlan = nativeExecutionPolicy.excludeCurrentProvider
      ? {
          excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
            providerKey: args.providerKey,
            excludedProviderKeys: args.excludedProviderKeys
          })
        }
      : { excludedCurrentProvider: false };
  const requestLocalTransient =
    classification === 'recoverable'
    && !hostContractFailure
    && !args.forceExcludeCurrentProviderOnRetry
    && !args.promptTooLong
    && !exclusionPlan.excludedCurrentProvider
    && shouldApplyProviderTransportBackoff({
      error: args.error,
      retryError: args.retryError,
      stage: args.stage
    });

  const holdOnLastAvailable429 = isLastAvailableProvider429({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys,
    retryError: args.retryError
  });
  const hasAlternativeCandidate = hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  const retryExcludedCurrentProvider = exclusionPlan.excludedCurrentProvider;
  const shouldSkipBackoffForImmediate429Reroute =
    retryExcludedCurrentProvider
    && !holdOnLastAvailable429
    && hasAlternativeCandidate
    && !requestLocalTransient;

  const hasTerminalAlternativeCandidate =
    exclusionPlan.excludedCurrentProvider
    && !holdOnLastAvailable429
    && hasAlternativeCandidate;
  const terminalPeriodicPolicyDecision =
    shouldRerouteTerminalPeriodicRecovery({
      classification,
      shouldRetry: eligibilityPlan.shouldRetry,
      hasTerminalAlternativeCandidate
    });
  const terminalUnrecoverablePolicyDecision =
    shouldRerouteTerminalUnrecoverableProviderFailure({
      classification,
      shouldRetry: eligibilityPlan.shouldRetry,
      hasTerminalAlternativeCandidate,
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode
    });
  if (!eligibilityPlan.shouldRetry && !terminalPeriodicPolicyDecision && !terminalUnrecoverablePolicyDecision) {
    const keepTerminalExclusion = exclusionPlan.excludedCurrentProvider;
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: keepTerminalExclusion,
      requestLocalTransient,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }

  if (terminalPeriodicPolicyDecision || terminalUnrecoverablePolicyDecision) {
    const retryBackoffPlan = await resolveProviderRetryBackoffPlan({
          error: args.error,
          retryError: args.retryError,
          providerKey: args.providerKey,
          runtimeKey: args.runtimeKey,
          stage: args.stage,
          attempt: args.attempt,
          forceProviderScopedBackoff: true,
          forceAttemptScopedBackoff: false,
          skipBackoffWait: shouldSkipBackoffForImmediate429Reroute,
          abortSignal: args.abortSignal,
          logNonBlockingError: args.logNonBlockingError
    });
    const retrySwitchPlan = buildProviderRetrySwitchPlan({
      runtimeKey: args.runtimeKey,
      routePool: args.routePool,
      runtimeManager: args.runtimeManager,
      excludedProviderKeys: args.excludedProviderKeys,
      excludedCurrentProvider: true,
      promptTooLong: args.promptTooLong,
      error: args.error,
      retryError: args.retryError,
      backoffScope: retryBackoffPlan.backoffScope
    });
    if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
      return {
        shouldRetry: false,
        blockingRecoverable: eligibilityPlan.blockingRecoverable,
        excludedCurrentProvider: true,
        requestLocalTransient,
        holdOnLastAvailable429,
        retryBackoffMs: 0,
        recoverableBackoffMs: 0
      };
    }
    return {
      shouldRetry: true,
      blockingRecoverable: false,
      excludedCurrentProvider: true,
      requestLocalTransient,
      holdOnLastAvailable429,
      retryBackoffMs: retryBackoffPlan.retryBackoffMs,
      recoverableBackoffMs: retryBackoffPlan.recoverableBackoffMs,
      backoffScope: retryBackoffPlan.backoffScope,
      retrySwitchPlan,
      retryExecutionPolicyReason: nativeExecutionPolicy.reason
    };
  }

  if (
    shouldDirectReturnUnrecoverableWithoutForcedExclusion({
      classification,
      excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
      retryable: (args.error as { retryable?: boolean } | undefined)?.retryable
    })
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      requestLocalTransient,
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
    forceProviderScopedBackoff: retryExcludedCurrentProvider,
    forceAttemptScopedBackoff: hostContractFailure && !retryExcludedCurrentProvider,
    requestLocal: requestLocalTransient,
    skipBackoffWait: shouldSkipBackoffForImmediate429Reroute,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  const retrySwitchPlan = buildProviderRetrySwitchPlan({
    runtimeKey: args.runtimeKey,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    promptTooLong: args.promptTooLong,
    error: args.error,
    retryError: args.retryError,
    backoffScope: retryBackoffPlan.backoffScope
  });
  if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: retryExcludedCurrentProvider,
      requestLocalTransient,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }
  if (
    shouldCancelUnrecoverableRerouteWithoutAlternative({
      classification,
      switchAction: 'reroute_explicit_alternative',
      hasAlternativeCandidate
    })
  ) {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: retryExcludedCurrentProvider,
      requestLocalTransient,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }
  return {
    shouldRetry: true,
    blockingRecoverable: eligibilityPlan.blockingRecoverable,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    requestLocalTransient,
    holdOnLastAvailable429,
    retryBackoffMs: retryBackoffPlan.retryBackoffMs,
    recoverableBackoffMs: retryBackoffPlan.recoverableBackoffMs,
    backoffScope: retryBackoffPlan.backoffScope,
    retrySwitchPlan,
    retryExecutionPolicyReason: nativeExecutionPolicy.reason
  };
}
