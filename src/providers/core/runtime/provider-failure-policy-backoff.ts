import type { ProviderFailureBackoffPlan, ProviderFailureBackoffScope } from './provider-failure-policy.js';

const PROVIDER_FAILURE_BACKOFF_DELAY_SEQUENCE_MS = [1_000, 2_000, 3_000] as const;

export function resolveProviderFailureBackoffPlanBlock(args: {
  scope: ProviderFailureBackoffScope;
  error?: unknown;
  statusCode?: number;
}): ProviderFailureBackoffPlan {
  const scope = args.scope;
  if (scope === 'none') {
    return {
      scope,
      keyKind: scope,
      delaySequenceMs: []
    };
  }
  return {
    scope,
    keyKind: scope,
    delaySequenceMs: PROVIDER_FAILURE_BACKOFF_DELAY_SEQUENCE_MS
  };
}

export function computeProviderFailureBackoffDelayMsBlock(args: {
  scope: Exclude<ProviderFailureBackoffScope, 'none'>;
  error?: unknown;
  statusCode?: number;
  attempt?: number;
  consecutive?: number;
}): number {
  const plan = resolveProviderFailureBackoffPlanBlock({
    scope: args.scope,
    error: args.error,
    statusCode: args.statusCode
  });
  const stepRaw =
    typeof args.consecutive === 'number' && Number.isFinite(args.consecutive)
      ? args.consecutive
      : args.attempt;
  const step = Math.max(1, Math.floor(typeof stepRaw === 'number' && Number.isFinite(stepRaw) ? stepRaw : 1));
  return plan.delaySequenceMs[
    (step - 1) % plan.delaySequenceMs.length
  ] ?? PROVIDER_FAILURE_BACKOFF_DELAY_SEQUENCE_MS[0];
}
