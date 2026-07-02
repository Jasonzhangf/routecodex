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
  shouldRetry: boolean;
  excludedCurrentProvider: boolean;
  blockedByProtocolBoundary?: boolean;
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
