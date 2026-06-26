import {
  describeProviderFailureDecision,
  resolveProviderFailureExclusionDecision,
  resolveProviderFailureRetryEligibility
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  readString,
  normalizeCodeKey
} from './request-executor-error-shared.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';
import {
  resolveRequestExecutorProviderErrorClassification
} from './request-executor-provider-failure.js';
import type {
  ProviderRetryEligibilityPlan,
  ProviderRetryExclusionPlan,
  ProviderRetryExecutionPlan,
  ProviderRetrySwitchAction,
  ProviderRetrySwitchPlan,
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

const MAX_CONTEXT_OVERFLOW_RETRIES = 3;

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
};

export function hasAlternativeRouteCandidate(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  const currentProviderKey = readString(args.providerKey);
  if (!Array.isArray(args.routePool) || args.routePool.length === 0) {
    return false;
  }
  return args.routePool.some((candidate) => {
    const normalized = readString(candidate);
    if (!normalized) {
      return false;
    }
    if (currentProviderKey && normalized === currentProviderKey) {
      return false;
    }
    return !args.excludedProviderKeys.has(normalized);
  });
}

function hasExplicitAlternativeRouteCandidate(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  return hasAlternativeRouteCandidate(args);
}

export function applyRetryExclusionForCurrentProvider(args: {
  providerKey?: string;
  excludedProviderKeys: Set<string>;
}): boolean {
  const providerKey = readString(args.providerKey);
  if (!providerKey) {
    return false;
  }
  args.excludedProviderKeys.add(providerKey);
  return true;
}

export function resolveProviderRetryExclusionPlan(args: {
  providerKey?: string;
  status?: number;
  error: unknown;
  retryError?: RetryErrorSnapshot;
  classification?: RequestExecutorProviderErrorClassification;
  attempt?: number;
  promptTooLong: boolean;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): ProviderRetryExclusionPlan {
  const providerKey = readString(args.providerKey);
  if (!providerKey) {
    return {
      excludedCurrentProvider: false
    };
  }
  const is429 = args.status === 429;
  const hasAlternativeCandidate = hasExplicitAlternativeRouteCandidate({
    providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  const hasExplicitRoutePool = Array.isArray(args.routePool) && args.routePool.length > 0;
  const exclusionDecision = resolveProviderFailureExclusionDecision({
    hasAlternativeCandidate,
  });
  if (exclusionDecision.excludeCurrentProvider && hasExplicitRoutePool) {
    return {
      excludedCurrentProvider: applyRetryExclusionForCurrentProvider({
        providerKey,
        excludedProviderKeys: args.excludedProviderKeys
      })
    };
  }
  return {
    excludedCurrentProvider: false
  };
}

export function isLastAvailableProvider429(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
  retryError: RetryErrorSnapshot;
}): boolean {
  const status = typeof args.retryError.statusCode === 'number' ? args.retryError.statusCode : undefined;
  const errorCode = normalizeCodeKey(args.retryError.errorCode);
  const upstreamCode = normalizeCodeKey(args.retryError.upstreamCode);
  const known = normalizeKnownProviderError({
    statusCode: status,
    code: errorCode,
    upstreamCode,
    message: args.retryError.reason,
  });
  const is429 = known?.code?.startsWith('429.') || status === 429 || errorCode === 'HTTP_429' || upstreamCode === 'HTTP_429';
  if (!is429 || !readString(args.providerKey)) {
    return false;
  }
  if (!Array.isArray(args.routePool) || args.routePool.length === 0) {
    return true;
  }
  return !hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
}

export function resolveProviderRetryEligibilityPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
}): ProviderRetryEligibilityPlan {
  const eligibility = resolveProviderFailureRetryEligibility({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    classification: resolveRequestExecutorProviderErrorClassification({
      error: args.error,
      retryError: args.retryError,
      stage: args.stage
    }),
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries ?? MAX_CONTEXT_OVERFLOW_RETRIES,
    allowNonPolicyRetry: false,
    stageOutsideProviderFailurePolicy: args.stage === 'host.response_contract'
  });
  return {
    shouldRetry: eligibility.shouldRetry,
    blockingRecoverable: eligibility.blockingRecoverable
  };
}

export function buildProviderRetrySwitchPlan(args: {
  runtimeKey?: string;
  routePool?: string[];
  runtimeManager?: RuntimeManager;
  excludedProviderKeys: Set<string>;
  excludedCurrentProvider: boolean;
  promptTooLong?: boolean;
  error?: unknown;
  retryError?: RetryErrorSnapshot;
}): ProviderRetrySwitchPlan {
  const switchAction: ProviderRetrySwitchAction = 'exclude_and_reroute';
  const runtimeScopeExcluded: string[] = [];
  return {
    switchAction,
    decisionLabel: describeProviderFailureDecision({
      action: 'reroute_explicit_alternative'
    }),
    runtimeScopeExcluded,
    runtimeScopeExcludedCount: runtimeScopeExcluded.length
  };
}
