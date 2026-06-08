// Re-export implementation from extracted module
export {
  normalizeProviderFailureCodeKey,
  isProviderFailureClientDisconnect,
  isProviderFailureNetworkTransportLike,
  resolveProviderFailureClassification,
  resolveProviderFailureOutcome,
  isBlockingRecoverableProviderFailure,
  describeProviderFailureDecision,
  resolveProviderFailureBackoffPlan,
  computeProviderFailureBackoffDelayMs,
  resolveProviderFailureActionPlan,
  resolveProviderFailureRetryEligibility,
  resolveProviderFailureExclusionDecision,
  shouldKeepProviderExcludedForNextAttempt,
  shouldRerouteTerminalPeriodicRecovery,
  shouldRerouteTerminalUnrecoverableProviderFailure,
  shouldDirectReturnUnrecoverableWithoutForcedExclusion,
  shouldCancelUnrecoverableRerouteWithoutAlternative,
  shouldSuppressForcedProviderExclusion,
  isProviderFailureHealthNeutral,
  extractProviderFailureStatusCode,
  classify_error_err_03_runtime_from_error_err_02_host,
} from './provider-failure-policy-impl.js';

export type ProviderFailureClassification =
  | 'unrecoverable'
  | 'recoverable'
  | 'special_400'
  | 'periodic_recovery';

export type ProviderFailureRateLimitKind =
  | 'synthetic_cooldown'
  | 'daily_limit'
  | 'short_lived';

export type ProviderFailureRetryAction =
  | 'reroute_explicit_alternative';

export type ProviderFailureAction =
  | 'direct_return'
  | ProviderFailureRetryAction;

export type ProviderFailureBackoffScope =
  | 'none'
  | 'attempt'
  | 'recoverable'
  | 'provider';

export type ProviderFailureDecisionLabel =
  | 'direct_return'
  | 'attempt_backoff_then_reroute'
  | 'recoverable_backoff_then_reroute'
  | 'provider_backoff_then_reroute';

export type ProviderFailureBackoffPlan = {
  scope: ProviderFailureBackoffScope;
  keyKind: ProviderFailureBackoffScope;
  baseMs: number;
  maxMs: number;
};

export type ProviderFailureActionPlan = {
  classification?: ProviderFailureClassification;
  affectsHealth: boolean;
  blockingRecoverable: boolean;
  shouldRetry: boolean;
  action: ProviderFailureAction;
  backoff: ProviderFailureBackoffPlan;
  decisionLabel: ProviderFailureDecisionLabel;
};

export type ProviderFailureRetryEligibilityPlan = {
  classification?: ProviderFailureClassification;
  blockingRecoverable: boolean;
  shouldRetry: boolean;
};

export type ProviderFailureOutcome = {
  classification?: ProviderFailureClassification;
  recoverable: boolean;
  affectsHealth: boolean;
};

export type ProviderFailureExclusionDecision = {
  excludeCurrentProvider: boolean;
  retryAction: ProviderFailureRetryAction;
};

export type ProviderFailureStage =
  | 'provider.runtime_resolve'
  | 'provider.send'
  | 'host.response_contract'
  | 'provider.followup'
  | 'provider.sse_decode'
  | 'provider.http'
  | 'provider.runtime.init'
  | 'provider.responses';
