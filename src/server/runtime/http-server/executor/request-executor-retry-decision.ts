import {
  readString
} from './request-executor-error-shared.js';
import type {
  ProviderRetryExclusionPlan,
  RequestExecutorProviderErrorClassification,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

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
