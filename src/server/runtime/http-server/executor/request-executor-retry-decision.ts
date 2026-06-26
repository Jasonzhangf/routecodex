import {
  resolveProviderFailureActionPlan,
  resolveProviderFailureClassification
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  readString,
  normalizeCodeKey
} from './request-executor-error-shared.js';
import type {
  ProviderRetryEligibilityPlan,
  ProviderRetryExclusionPlan,
  ProviderRetryExecutionPlan,
  RequestExecutorProviderErrorClassification,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

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
  const hasAlternativeCandidate = hasAlternativeRouteCandidate({
    providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  const hasExplicitRoutePool = Array.isArray(args.routePool) && args.routePool.length > 0;
  if (hasAlternativeCandidate && hasExplicitRoutePool) {
    args.excludedProviderKeys.add(providerKey);
    return {
      excludedCurrentProvider: true
    };
  }
  return {
    excludedCurrentProvider: false
  };
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
  const eligibility = resolveProviderFailureActionPlan({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    classification: resolveProviderFailureClassification({
      error: args.error,
      stage: args.stage,
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode,
      reason: args.retryError.reason
    }),
    promptTooLong: args.promptTooLong,
  });
  return {
    shouldRetry: eligibility.shouldRetry,
    blockingRecoverable: eligibility.blockingRecoverable
  };
}
