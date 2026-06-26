import {
  shouldKeepProviderExcludedForNextAttempt,
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  hasAlternativeRouteCandidate,
} from './request-executor-retry-decision.js';
import type {
  ExcludedProviderReselectionPlan,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export function resolveExcludedProviderReselectionPlan(args: {
  providerKey?: string;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
  lastError?: unknown;
  extractRetryErrorSnapshot?: (error: unknown) => RetryErrorSnapshot;
}): ExcludedProviderReselectionPlan {
  const hasAlternativeCandidate = hasAlternativeRouteCandidate({
    providerKey: args.providerKey,
    routePool: args.routePool,
    excludedProviderKeys: args.excludedProviderKeys
  });
  return {
    hasAlternativeCandidate,
    keepExcludedForNextAttempt: shouldKeepProviderExcludedForNextAttempt({
      hasAlternativeCandidate
    })
  };
}
