import {
  resolveRequestExecutorProviderErrorClassification,
} from './request-executor-provider-failure.js';
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
  const classification =
    args.lastError
      ? resolveRequestExecutorProviderErrorClassification({
        error: args.lastError,
        retryError:
          args.extractRetryErrorSnapshot?.(args.lastError)
          ?? {
            statusCode: undefined,
            errorCode: undefined,
            upstreamCode: undefined,
            reason: args.lastError instanceof Error ? args.lastError.message : String(args.lastError ?? '')
          },
        stage: 'provider.send'
      })
      : undefined;
  return {
    hasAlternativeCandidate,
    keepExcludedForNextAttempt: shouldKeepProviderExcludedForNextAttempt({
      classification,
      hasAlternativeCandidate
    })
  };
}
