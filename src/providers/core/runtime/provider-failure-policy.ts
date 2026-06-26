// Re-export implementation from extracted module
export {
  normalizeProviderFailureCodeKey,
  isProviderFailureClientDisconnect,
  isProviderFailureNetworkTransportLike,
  resolveProviderFailureClassification,
  resolveProviderFailureOutcome,
  isBlockingRecoverableProviderFailure,
  describeProviderFailureDecision,
  resolveProviderFailureActionPlan,
  resolveProviderFailureRetryEligibility,
  resolveProviderFailureExclusionDecision,
  shouldKeepProviderExcludedForNextAttempt,
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
  | 'special_400';

export type ProviderFailureRateLimitKind =
  | 'short_lived';

export type ProviderFailureRetryAction =
  | 'reroute_explicit_alternative';

export type ProviderFailureAction =
  | 'direct_return'
  | ProviderFailureRetryAction;

export type ProviderFailureDecisionLabel =
  | 'direct_return'
  | 'exclude_and_reroute';

export type ProviderFailureActionPlan = {
  classification?: ProviderFailureClassification;
  affectsHealth: boolean;
  blockingRecoverable: boolean;
  shouldRetry: boolean;
  action: ProviderFailureAction;
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
