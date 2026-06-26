import type { ProviderFailureBackoffPlan, ProviderFailureBackoffScope } from './provider-failure-policy.js';

export function resolveProviderFailureBackoffPlanBlock(args: {
  scope: ProviderFailureBackoffScope;
  error?: unknown;
  statusCode?: number;
}): ProviderFailureBackoffPlan {
  return {
    scope: 'none',
    keyKind: 'none',
    delaySequenceMs: []
  };
}

export function computeProviderFailureBackoffDelayMsBlock(args: {
  scope: ProviderFailureBackoffScope;
  error?: unknown;
  statusCode?: number;
  attempt?: number;
  consecutive?: number;
}): number {
  return 0;
}
