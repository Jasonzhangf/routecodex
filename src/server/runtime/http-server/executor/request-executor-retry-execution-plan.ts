import {
  isHostRequestExecutorErrorStage,
  resolveRequestExecutorProviderErrorClassification,
} from './request-executor-provider-failure.js';
import {
  shouldCancelUnrecoverableRerouteWithoutAlternative,
  shouldDirectReturnUnrecoverableWithoutForcedExclusion,
  shouldRerouteTerminalPeriodicRecovery,
} from '../../../../providers/core/runtime/provider-failure-policy.js';
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

export type RequestExecutorErrorErr04RouterPolicyEnvelope = {
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
          status: args.retryError.statusCode ?? args.status,
          error: args.error,
          classification,
          attempt: args.attempt,
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

  const hasTerminalAlternativeCandidate =
    exclusionPlan.excludedCurrentProvider
    && !holdOnLastAvailable429
    && hasAlternativeRouteCandidate({
      providerKey: args.providerKey,
      routePool: args.routePool,
      excludedProviderKeys: args.excludedProviderKeys
    });
  const terminalQuotaReroute =
    shouldRerouteTerminalPeriodicRecovery({
      classification,
      shouldRetry: eligibilityPlan.shouldRetry,
      hasTerminalAlternativeCandidate
    });
  if (!eligibilityPlan.shouldRetry && !terminalQuotaReroute) {
    const keepTerminalExclusion =
      exclusionPlan.excludedCurrentProvider
      && (args.status === 429 || args.forceExcludeCurrentProviderOnRetry === true);
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: keepTerminalExclusion,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0
    };
  }

  if (terminalQuotaReroute) {
    const retryBackoffPlan = await resolveProviderRetryBackoffPlan({
          error: args.error,
          retryError: args.retryError,
          providerKey: args.providerKey,
          runtimeKey: args.runtimeKey,
          stage: args.stage,
          attempt: args.attempt,
          forceProviderScopedBackoff: true,
          forceAttemptScopedBackoff: false,
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
    return {
      shouldRetry: true,
      blockingRecoverable: false,
      excludedCurrentProvider: true,
      holdOnLastAvailable429,
      retryBackoffMs: retryBackoffPlan.retryBackoffMs,
      recoverableBackoffMs: retryBackoffPlan.recoverableBackoffMs,
      backoffScope: retryBackoffPlan.backoffScope,
      retrySwitchPlan
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
    shouldCancelUnrecoverableRerouteWithoutAlternative({
      classification,
      switchAction: retrySwitchPlan.switchAction === 'exclude_and_reroute'
        ? 'reroute_explicit_alternative'
        : 'retry_same_provider',
      hasAlternativeCandidate: hasAlternativeRouteCandidate({
        providerKey: args.providerKey,
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys
      })
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
