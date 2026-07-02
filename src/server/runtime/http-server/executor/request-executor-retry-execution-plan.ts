import {
  isHostRequestExecutorErrorStage,
} from './request-executor-provider-failure.js';
import {
  readString
} from './request-executor-error-shared.js';
import {
  resolveProviderRetryExecutionPolicyNative,
} from '../../../../modules/llmswitch/bridge/native-exports.js';
import {
  hasAlternativeRouteCandidate,
  resolveProviderRetryExclusionPlan
} from './request-executor-retry-decision.js';
import {
  resolveProviderFailureActionPlan,
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
  resolveRuntimeKey(providerKey?: string, metadata?: Record<string, unknown>): string | undefined;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

function isCurrentOnlyRoutePool(args: {
  providerKey?: string;
  routePool?: string[];
}): boolean {
  const providerKey = readString(args.providerKey);
  if (!providerKey || !Array.isArray(args.routePool) || args.routePool.length === 0) {
    return false;
  }
  return args.routePool.every((candidate) => readString(candidate) === providerKey);
}

function isLastProviderRetryEligibleStage(stage?: RequestExecutorProviderErrorStage): boolean {
  return stage === 'provider.send'
    || stage === 'provider.http'
    || stage === 'provider.sse_decode';
}

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
  routePoolIsAuthoritative?: boolean;
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
  const retryActionPlan = resolveProviderFailureActionPlan({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    classification,
    promptTooLong: args.promptTooLong,
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
  const nativeExecutionPolicy = resolveProviderRetryExecutionPolicyNative({
    classification,
    isStreamingRequest: args.isStreamingRequest === true,
    hostContractFailure,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry === true,
    errorCode: args.retryError.errorCode,
    promptTooLong: args.promptTooLong === true,
    existingExclusion: baseExclusionPlan.excludedCurrentProvider,
  });
  const mayRetryVerifiedLastProvider =
    args.routePoolIsAuthoritative === true
    && isCurrentOnlyRoutePool({
      providerKey: args.providerKey,
      routePool: args.routePool
    })
    && args.defaultTierAvailable !== true
    && args.promptTooLong !== true
    && args.providerOwnedContinuation !== true
    && args.attempt < args.maxAttempts
    && isLastProviderRetryEligibleStage(args.stage)
    && retryActionPlan.shouldRetry;
  const exclusionPlan = (
    (
      nativeExecutionPolicy.excludeCurrentProvider
      || baseExclusionPlan.excludedCurrentProvider
    )
    && !mayRetryVerifiedLastProvider
  )
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
    && !retryActionPlan.shouldRetry
    && retryExcludedCurrentProvider
    && hasTerminalAlternativeCandidate;
  const gate = resolveProviderRetryExecutionPlanExhaustionGate({
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys,
    defaultPoolAvailable: args.defaultTierAvailable === true,
  });
  const maySwitchToAlternativeProvider = hasAlternativeCandidate && exclusionPlan.excludedCurrentProvider;
  if (!hasAlternativeCandidate) {
    if (
      args.promptTooLong === true
      && retryActionPlan.shouldRetry
      && !hostContractFailure
      && args.providerKey
      && args.attempt < args.maxAttempts
    ) {
      args.excludedProviderKeys.add(args.providerKey);
      const promptTooLongGate = resolveProviderRetryExecutionPlanExhaustionGate({
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys,
        defaultPoolAvailable: args.defaultTierAvailable === true,
      });
      const retrySwitchPlan = {
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'exclude_and_reroute',
        runtimeScopeExcluded: [],
        runtimeScopeExcludedCount: 0
      } as NonNullable<ProviderRetryExecutionPlan['retrySwitchPlan']>;
      return {
        shouldRetry: true,
        excludedCurrentProvider: true,
        retrySwitchPlan,
        retryExecutionPolicyReason: 'prompt_too_long_route_hint_retry',
        routePoolRemainingAfterExclusion: promptTooLongGate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: promptTooLongGate.defaultPoolAvailable,
        policyExhausted: promptTooLongGate.policyExhausted,
        mayProject: promptTooLongGate.mayProject,
      };
    }
    if (
      gate.defaultPoolAvailable && !gate.mayProject
    ) {
      if (args.providerKey) {
        args.excludedProviderKeys.add(args.providerKey);
      }
      const defaultPoolGate = resolveProviderRetryExecutionPlanExhaustionGate({
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys,
        defaultPoolAvailable: true,
      });
      const retrySwitchPlan = {
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'exclude_and_reroute',
        runtimeScopeExcluded: [],
        runtimeScopeExcludedCount: 0
      } as NonNullable<ProviderRetryExecutionPlan['retrySwitchPlan']>;
      return {
        shouldRetry: true,
        excludedCurrentProvider: Boolean(args.providerKey),
        retrySwitchPlan,
        retryExecutionPolicyReason: nativeExecutionPolicy.reason,
        routePoolRemainingAfterExclusion: defaultPoolGate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: defaultPoolGate.defaultPoolAvailable,
        policyExhausted: defaultPoolGate.policyExhausted,
        mayProject: defaultPoolGate.mayProject,
      };
    }
    if (mayRetryVerifiedLastProvider) {
      return {
        shouldRetry: true,
        excludedCurrentProvider: false,
        retryExecutionPolicyReason: nativeExecutionPolicy.reason,
        routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: gate.defaultPoolAvailable,
        policyExhausted: gate.policyExhausted,
        mayProject: gate.mayProject,
      };
    }
    if (
      retryActionPlan.shouldRetry
      && !hostContractFailure
      && args.providerKey
      && args.attempt < args.maxAttempts
      && args.providerOwnedContinuation !== true
    ) {
      args.excludedProviderKeys.add(args.providerKey);
      const retrySwitchGate = resolveProviderRetryExecutionPlanExhaustionGate({
        routePool: args.routePool,
        excludedProviderKeys: args.excludedProviderKeys,
        defaultPoolAvailable: args.defaultTierAvailable === true,
      });
      const retrySwitchPlan = {
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'exclude_and_reroute',
        runtimeScopeExcluded: [],
        runtimeScopeExcludedCount: 0
      } as NonNullable<ProviderRetryExecutionPlan['retrySwitchPlan']>;
      return {
        shouldRetry: true,
        excludedCurrentProvider: true,
        retrySwitchPlan,
        retryExecutionPolicyReason: nativeExecutionPolicy.reason,
        routePoolRemainingAfterExclusion: retrySwitchGate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: retrySwitchGate.defaultPoolAvailable,
        policyExhausted: args.routePoolIsAuthoritative === true
          ? retrySwitchGate.policyExhausted
          : false,
        mayProject: false,
      };
    }
    return {
      shouldRetry: false,
      excludedCurrentProvider: false,
      routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
      defaultPoolAvailable: gate.defaultPoolAvailable,
      policyExhausted: gate.policyExhausted,
      mayProject: gate.mayProject,
    };
  }
  if (!retryActionPlan.shouldRetry && !shouldRerouteExcludedFailure) {
    const keepTerminalExclusion = exclusionPlan.excludedCurrentProvider;
    return {
      shouldRetry: maySwitchToAlternativeProvider,
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
        excludedCurrentProvider: true,
        routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
        defaultPoolAvailable: gate.defaultPoolAvailable,
        policyExhausted: gate.policyExhausted,
        mayProject: gate.mayProject,
      };
    }
    return {
      shouldRetry: true,
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
      excludedCurrentProvider: retryExcludedCurrentProvider,
      routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
      defaultPoolAvailable: gate.defaultPoolAvailable,
      policyExhausted: gate.policyExhausted,
      mayProject: gate.mayProject,
    };
  }
  return {
    shouldRetry: true,
    excludedCurrentProvider: retryExcludedCurrentProvider,
    retrySwitchPlan,
    retryExecutionPolicyReason: nativeExecutionPolicy.reason,
    routePoolRemainingAfterExclusion: gate.routePoolRemainingAfterExclusion,
    defaultPoolAvailable: gate.defaultPoolAvailable,
    policyExhausted: gate.policyExhausted,
    mayProject: gate.mayProject,
  };
}
