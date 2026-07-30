import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderFailureClassification } from '../../../../providers/core/runtime/provider-failure-policy.js';

export type RetryErrorSnapshot = {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  upstreamStatus?: number;
  catalogCode?: string;
  catalogKey?: string;
  reason: string;
};

export type RequestExecutorProviderErrorStage =
  | 'provider.runtime_resolve'
  | 'provider.send'
  | 'host.response_contract'
  | 'provider.followup'
  | 'provider.sse_decode'
  | 'provider.http';

export type RequestExecutorProviderErrorClassification = ProviderFailureClassification;

export type ProviderRetrySwitchAction = 'exclude_and_reroute';

export type ProviderRetrySwitchPlan = {
  switchAction: ProviderRetrySwitchAction;
  decisionLabel: string;
  runtimeScopeExcluded: string[];
  runtimeScopeExcludedCount: number;
};

export type ProviderRetryExclusionPlan = {
  excludedCurrentProvider: boolean;
};

export type ProviderRetryExecutionPlan = {
  action:
    | 'wait_then_retry_same'
    | 'wait_then_reselect'
    | 'project_terminal'
    | 'client_disconnected'
    | 'reject_non_provider_error';
  shouldRetry: boolean;
  excludedCurrentProvider: boolean;
  allowRetryBeyondAttemptBudget: boolean;
  retrySwitchPlan?: ProviderRetrySwitchPlan;
  retryExecutionPolicyReason?: string;
  /**
   * ErrorErr05ExecutionDecision top-node fields.
   * Locked by docs/goals/provider-error-reroutable-until-pool-and-default-empty.md.
   * `policyExhausted` is the single source of truth for client projection gating.
   * `mayProject` is the only client-projection predicate.
   */
  routePoolRemainingAfterExclusion: string[];
  defaultPoolAvailable: boolean;
  policyExhausted: boolean;
  mayProject: boolean;
};

export const ERROR_ERR05_EXECUTION_DECISION_PROPERTY =
  'routecodexErrorErr05ExecutionDecision' as const;

export function attachErrorErr05ExecutionDecision(
  error: unknown,
  decision: ProviderRetryExecutionPlan
): void {
  if (
    decision.action === 'client_disconnected'
    || decision.action === 'reject_non_provider_error'
    || !error
    || (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return;
  }
  Object.defineProperty(error, ERROR_ERR05_EXECUTION_DECISION_PROPERTY, {
    value: decision,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

export function readErrorErr05ExecutionDecision(
  error: unknown
): ProviderRetryExecutionPlan | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }
  const decision = (error as Record<string, unknown>)[ERROR_ERR05_EXECUTION_DECISION_PROPERTY];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return undefined;
  }
  return decision as ProviderRetryExecutionPlan;
}

export type ProviderRetryTelemetryPlan = {
  switchLogArgs: {
    requestId: string;
    attempt: number;
    maxAttempts: number;
    providerKey?: string;
    nextAttempt: number;
    reason: string;
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    upstreamStatus?: number;
    catalogCode?: string;
    catalogKey?: string;
    switchAction: ProviderRetrySwitchAction;
    decisionLabel?: string;
    retryExecutionPolicyReason?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  };
  retryStageDetails: Record<string, unknown>;
  runtimeScopeExcludeDetails?: Record<string, unknown>;
};

export type ExcludedProviderReselectionPlan = {
  hasAlternativeCandidate: boolean;
};

export type RequestExecutorProviderErrorReportPlan = {
  errorCode?: string;
  upstreamCode?: string;
  upstreamStatus?: number;
  statusCode?: number;
  stageHint: RequestExecutorProviderErrorStage;
};

export type RequestExecutorProviderFailurePlan = {
  reportPlan: RequestExecutorProviderErrorReportPlan;
  retryExecutionPlan: ProviderRetryExecutionPlan;
  retryTelemetryPlan?: ProviderRetryTelemetryPlan;
};

export type ProviderErrorStageLogger = (
  stage: string,
  requestId: string,
  details?: Record<string, unknown>
) => void;

export type ReportRequestExecutorProviderErrorArgs = {
  error: unknown;
  retryError: RetryErrorSnapshot;
  requestId: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol?: string;
  routeName?: string;
  routecodexRoutingPolicyGroup?: string;
  runtimeKey?: string;
  target?: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  logStage: ProviderErrorStageLogger;
  stageHint?: RequestExecutorProviderErrorStage;
  extraDetails?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  routePool?: string[];
  excludedProviderKeys?: Set<string>;
};
