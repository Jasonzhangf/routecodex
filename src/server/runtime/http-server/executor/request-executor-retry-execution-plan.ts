import {
  isHostRequestExecutorErrorStage,
  resolveRequestExecutorProviderErrorClassification,
  shouldApplyProviderTransportBackoff,
} from './request-executor-provider-failure.js';
import {
  shouldCancelUnrecoverableRerouteWithoutAlternative,
  shouldDirectReturnUnrecoverableWithoutForcedExclusion,
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
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

function isReroutableHostResponseContractRetryError(retryError: RetryErrorSnapshot): boolean {
  return retryError.errorCode === 'EMPTY_ASSISTANT_RESPONSE'
    || retryError.errorCode === 'MISSING_REQUIRED_TOOL_CALL';
}

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

/**
 * ErrorErr05 execution-decision exhaustion gate.
 *
 * Pure derivation. The only owner of `mayProject` / `policyExhausted`.
 * `mayProject = policyExhausted = routePoolRemainingAfterExclusion.length === 0 && !defaultPoolAvailable`.
 *
 * Caller MUST pass:
 *  - `routePool` (raw current tier pool, may be undefined)
 *  - `excludedProviderKeys` (set of keys already excluded this attempt chain)
 *  - `defaultPoolAvailable` (VR-provided, true when a non-empty default pool exists for this routing group)
 *
 * Locked by docs/goals/provider-error-reroutable-until-pool-and-default-empty.md §2.1.
 * Red test: tests/red-tests/error_chain_may_project_gate.test.ts.
 */
export function resolveProviderRetryExecutionPlanExhaustionGate(args: {
  routePool?: string[];
  excludedProviderKeys: Set<string>;
  defaultPoolAvailable: boolean;
}): {
  routePoolRemainingAfterExclusion: string[];
  defaultPoolAvailable: boolean;
  policyExhausted: boolean;
  mayProject: boolean;
} {
  const rawPool = Array.isArray(args.routePool) ? args.routePool : [];
  const remaining = rawPool.filter((candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    return !args.excludedProviderKeys.has(candidate);
  });
  const policyExhausted = remaining.length === 0 && args.defaultPoolAvailable === false;
  const mayProject = policyExhausted;
  return {
    routePoolRemainingAfterExclusion: remaining,
    defaultPoolAvailable: args.defaultPoolAvailable === true,
    policyExhausted,
    mayProject,
  };
}

/**
 * Build the ErrorErr05 gate fields once, then return a new plan that merges
 * the partial decisions with the gate. Centralized so that all return paths
 * share the same source of truth for `mayProject` / `policyExhausted`.
 */
function attachErrorErr05ExhaustionGate(
  partial: Omit<ProviderRetryExecutionPlan,
    'routePoolRemainingAfterExclusion' | 'defaultPoolAvailable' | 'policyExhausted' | 'mayProject'>,
  routePool: string[] | undefined,
  excludedProviderKeys: Set<string>,
  defaultTierAvailable: boolean | undefined,
): ProviderRetryExecutionPlan {
  const gate = resolveProviderRetryExecutionPlanExhaustionGate({
    routePool,
    excludedProviderKeys,
    defaultPoolAvailable: defaultTierAvailable === true,
  });
  return {
    ...partial,
    routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
    defaultPoolAvailable: gate.defaultPoolAvailable,
    policyExhausted: gate.policyExhausted,
    mayProject: gate.mayProject,
  };
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
  abortSignal?: AbortSignal;
  /**
   * VR-derived truth: does the current routing group have a non-empty default
   * fallback tier that the policy may still try?
   *
   * Locked by docs/goals/provider-error-reroutable-until-pool-and-default-empty.md §2.1.
   * When `false` (or omitted), the gate treats the system as terminal-candidate-empty
   * and `mayProject` is permitted ONLY when `routePoolRemainingAfterExclusion.length === 0`.
   * Callers MUST wire this from `virtual_router.primary_exhausted_to_default_pool`.
   */
  defaultTierAvailable?: boolean;
  logNonBlockingError: LogNonBlockingError;
}): Promise<ProviderRetryExecutionPlan> {
  const hostContractStage = isHostRequestExecutorErrorStage(args.stage ?? 'provider.send');
  const hostContractFailure = hostContractStage && !isReroutableHostResponseContractRetryError(args.retryError);
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
        retryError: args.retryError
      });
  if (!classification) {
    throw new Error('[request-executor] provider failure classification missing');
  }
  const nativeExecutionPolicy = resolveRequestExecutorNativeRetryPolicy({
    classification,
    isStreamingRequest: args.isStreamingRequest === true,
    hostContractFailure,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry === true,
    errorCode: args.retryError.errorCode,
    promptTooLong: args.promptTooLong === true,
    existingExclusion: baseExclusionPlan.excludedCurrentProvider,
  });
  const exclusionPlan = (nativeExecutionPolicy.excludeCurrentProvider || baseExclusionPlan.excludedCurrentProvider)
      ? {
          excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
            providerKey: args.providerKey,
            excludedProviderKeys: args.excludedProviderKeys
          }) || baseExclusionPlan.excludedCurrentProvider
        }
      : { excludedCurrentProvider: false };
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
    && hasAlternativeCandidate;

  const hasTerminalAlternativeCandidate =
    !holdOnLastAvailable429
    && hasAlternativeCandidate
    && (
      exclusionPlan.excludedCurrentProvider
      || classification === 'unrecoverable'
    );
  const terminalUnrecoverablePolicyDecision =
    shouldRerouteTerminalUnrecoverableProviderFailure({
      classification,
      shouldRetry: eligibilityPlan.shouldRetry,
      hasTerminalAlternativeCandidate,
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode
    });
  if (!eligibilityPlan.shouldRetry && !terminalUnrecoverablePolicyDecision) {
    const keepTerminalExclusion = exclusionPlan.excludedCurrentProvider;
    return attachErrorErr05ExhaustionGate({
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: keepTerminalExclusion,
      holdOnLastAvailable429,
      retryBackoffMs: 0
    }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
  }

  if (terminalUnrecoverablePolicyDecision) {
  const retrySwitchPlan = buildProviderRetrySwitchPlan({
    runtimeKey: args.runtimeKey,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    excludedCurrentProvider: true,
    promptTooLong: args.promptTooLong,
    error: args.error,
    retryError: args.retryError
  });
    if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
      return attachErrorErr05ExhaustionGate({
        shouldRetry: false,
        blockingRecoverable: eligibilityPlan.blockingRecoverable,
        excludedCurrentProvider: true,
        holdOnLastAvailable429,
        retryBackoffMs: 0
      }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
    }
    return attachErrorErr05ExhaustionGate({
      shouldRetry: true,
      blockingRecoverable: false,
      excludedCurrentProvider: true,
      holdOnLastAvailable429,
      retryBackoffMs: 0,
      retrySwitchPlan,
      retryExecutionPolicyReason: nativeExecutionPolicy.reason
    }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
  }

  if (
    shouldDirectReturnUnrecoverableWithoutForcedExclusion({
      classification,
      excludedCurrentProvider: exclusionPlan.excludedCurrentProvider,
      retryable: (args.error as { retryable?: boolean } | undefined)?.retryable
    })
  ) {
    return attachErrorErr05ExhaustionGate({
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: false,
      holdOnLastAvailable429,
      retryBackoffMs: 0
    }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
  }

  const retrySwitchPlan = buildProviderRetrySwitchPlan({
    runtimeKey: args.runtimeKey,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    promptTooLong: args.promptTooLong,
    error: args.error,
    retryError: args.retryError
  });
  if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
    return attachErrorErr05ExhaustionGate({
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: retryExcludedCurrentProvider,
      holdOnLastAvailable429,
      retryBackoffMs: 0
    }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
  }
  if (
    shouldCancelUnrecoverableRerouteWithoutAlternative({
      classification,
      switchAction: 'reroute_explicit_alternative',
      hasAlternativeCandidate
    })
  ) {
    return attachErrorErr05ExhaustionGate({
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: retryExcludedCurrentProvider,
      holdOnLastAvailable429,
      retryBackoffMs: 0
    }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
  }
  return attachErrorErr05ExhaustionGate({
    shouldRetry: true,
    blockingRecoverable: eligibilityPlan.blockingRecoverable,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    holdOnLastAvailable429,
    retryBackoffMs: 0,
    retrySwitchPlan,
    retryExecutionPolicyReason: nativeExecutionPolicy.reason
  }, args.routePool, args.excludedProviderKeys, args.defaultTierAvailable);
}
