// Re-export implementation from extracted module
export {
  normalizeProviderFailureCodeKey,
  isProviderFailureClientDisconnect,
  isProviderFailureNetworkTransportLike,
  resolveProviderFailureClassification,
  resolveProviderFailureOutcome,
  resolveProviderFailureActionPlan,
  isProviderFailureHealthNeutral,
  extractProviderFailureStatusCode,
} from './provider-failure-policy-impl.js';

export type ProviderFailureClassification =
  | 'unrecoverable'
  | 'recoverable';

export type ProviderFailureRetryAction =
  | 'reroute_explicit_alternative';

export type ProviderFailureActionPlan = {
  classification?: ProviderFailureClassification;
  affectsHealth: boolean;
  shouldRetry: boolean;
  action: 'direct_return' | ProviderFailureRetryAction;
  decisionLabel: 'direct_return' | 'exclude_and_reroute';
};

export type ProviderFailureOutcome = {
  classification?: ProviderFailureClassification;
  recoverable: boolean;
  affectsHealth: boolean;
};
