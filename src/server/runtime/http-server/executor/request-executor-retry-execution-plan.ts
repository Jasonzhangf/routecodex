import {
  isHostRequestExecutorErrorStage,
} from './request-executor-provider-failure.js';
import {
  resolveRequestExecutorNativeRetryPolicy,
} from './request-executor-native-retry-policy.js';
import {
  hasAlternativeRouteCandidate,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExclusionPlan
} from './request-executor-retry-decision.js';
import {
  resolveProviderFailureClassification
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export const ERROR_EXECUTION_DECISION_CONSUMER_FEATURE_ID = 'feature_id: error.execution_decision_consumer';

export type RequestExecutorErrorErr04RouterPolicyEnvelope = {
// topology-node: ErrorErr04RouterPolicyApplied (executor-side envelope alias)
  retryExecutionPlan: ProviderRetryExecutionPlan;
};

export type ErrorErr05ExecutionDecision = ProviderRetryExecutionPlan;

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
  const hostContractFailure = hostContractStage
    && args.retryError.errorCode !== 'EMPTY_ASSISTANT_RESPONSE'
    && args.retryError.errorCode !== 'MISSING_REQUIRED_TOOL_CALL';
  const classification = resolveProviderFailureClassification({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
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
          excludedCurrentProvider: args.providerKey ? (args.excludedProviderKeys.add(args.providerKey), true) : baseExclusionPlan.excludedCurrentProvider
        }
      : { excludedCurrentProvider: false };
  const hasAlternativeCandidate = hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  const retryExcludedCurrentProvider = exclusionPlan.excludedCurrentProvider;
  const hasTerminalAlternativeCandidate =
    hasAlternativeCandidate
    && (
      exclusionPlan.excludedCurrentProvider
      || classification === 'unrecoverable'
    );
  const shouldRerouteExcludedFailure =
    !hostContractFailure
    && !eligibilityPlan.shouldRetry
    && retryExcludedCurrentProvider
    && hasTerminalAlternativeCandidate;
  const gate = resolveProviderRetryExecutionPlanExhaustionGate({
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys,
    defaultPoolAvailable: args.defaultTierAvailable === true,
  });
  if (!eligibilityPlan.shouldRetry && !shouldRerouteExcludedFailure) {
    const keepTerminalExclusion = exclusionPlan.excludedCurrentProvider;
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: keepTerminalExclusion,
      routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
      defaultPoolAvailable: gate.defaultPoolAvailable,
      policyExhausted: gate.policyExhausted,
      mayProject: gate.mayProject,
    };
  }

  if (shouldRerouteExcludedFailure) {
  const retrySwitchPlan = {
    switchAction: 'exclude_and_reroute',
    decisionLabel: 'exclude_and_reroute',
    runtimeScopeExcluded: [],
    runtimeScopeExcludedCount: 0
    } as NonNullable<ProviderRetryExecutionPlan['retrySwitchPlan']>;
    if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
      return {
        shouldRetry: false,
        blockingRecoverable: eligibilityPlan.blockingRecoverable,
        excludedCurrentProvider: true,
        routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: gate.defaultPoolAvailable,
        policyExhausted: gate.policyExhausted,
        mayProject: gate.mayProject,
      };
    }
    return {
      shouldRetry: true,
      blockingRecoverable: false,
      excludedCurrentProvider: true,
      retrySwitchPlan,
      retryExecutionPolicyReason: nativeExecutionPolicy.reason,
      routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
      defaultPoolAvailable: gate.defaultPoolAvailable,
      policyExhausted: gate.policyExhausted,
      mayProject: gate.mayProject,
    };
  }

  const retrySwitchPlan = {
    switchAction: 'exclude_and_reroute',
    decisionLabel: 'exclude_and_reroute',
    runtimeScopeExcluded: [],
    runtimeScopeExcludedCount: 0
  } as NonNullable<ProviderRetryExecutionPlan['retrySwitchPlan']>;
  if (args.providerOwnedContinuation === true && retrySwitchPlan.switchAction === 'exclude_and_reroute') {
    return {
      shouldRetry: false,
      blockingRecoverable: eligibilityPlan.blockingRecoverable,
      excludedCurrentProvider: retryExcludedCurrentProvider,
      routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
      defaultPoolAvailable: gate.defaultPoolAvailable,
      policyExhausted: gate.policyExhausted,
      mayProject: gate.mayProject,
    };
  }
  return {
    shouldRetry: true,
    blockingRecoverable: eligibilityPlan.blockingRecoverable,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    retrySwitchPlan,
    retryExecutionPolicyReason: nativeExecutionPolicy.reason,
    routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
    defaultPoolAvailable: gate.defaultPoolAvailable,
    policyExhausted: gate.policyExhausted,
    mayProject: gate.mayProject,
  };
}
