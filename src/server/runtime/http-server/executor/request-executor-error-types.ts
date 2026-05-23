import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderFailureClassification } from '../../../../providers/core/runtime/provider-failure-policy.js';

export type RetryErrorSnapshot = {
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  upstreamStatus?: number;
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

export type ProviderRetryBackoffPlan = {
  blockingRecoverable: boolean;
  retryBackoffMs: number;
  recoverableBackoffMs: number;
  backoffScope: 'provider' | 'recoverable' | 'attempt';
};

export type ProviderRetrySwitchAction = 'exclude_and_reroute' | 'retry_same_provider';

export type ProviderRetryBackoffScope = ProviderRetryBackoffPlan['backoffScope'];

export type ProviderRetrySwitchPlan = {
  switchAction: ProviderRetrySwitchAction;
  decisionLabel: string;
  runtimeScopeExcluded: string[];
  runtimeScopeExcludedCount: number;
};

export type ProviderRetryExclusionPlan = {
  excludedCurrentProvider: boolean;
};

export type ProviderRetryEligibilityPlan = {
  shouldRetry: boolean;
  blockingRecoverable: boolean;
};

export type ProviderRetryExecutionPlan = {
  shouldRetry: boolean;
  blockingRecoverable: boolean;
  excludedCurrentProvider: boolean;
  holdOnLastAvailable429: boolean;
  retryBackoffMs: number;
  recoverableBackoffMs: number;
  backoffScope?: ProviderRetryBackoffScope;
  retrySwitchPlan?: ProviderRetrySwitchPlan;
};

export type ProviderRetryTelemetryPlan = {
  switchLogArgs: {
    requestId: string;
    attempt: number;
    maxAttempts: number;
    providerKey?: string;
    nextAttempt: number;
    reason: string;
    backoffMs?: number;
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    upstreamStatus?: number;
    switchAction: ProviderRetrySwitchAction;
    backoffScope?: ProviderRetryBackoffScope;
    decisionLabel?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  };
  retryStageDetails: Record<string, unknown>;
  runtimeScopeExcludeDetails?: Record<string, unknown>;
};

export type ExcludedProviderReselectionPlan = {
  hasAlternativeCandidate: boolean;
  keepExcludedForNextAttempt: boolean;
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

export type BlockingRecoverableRouteHoldState = {
  providerKey?: string;
  runtimeKey?: string;
  retryError: RetryErrorSnapshot;
  holdOnLastAvailable429: boolean;
  explicitSingletonPool: boolean;
  preserveSameProviderRetry?: boolean;
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
  runtimeKey?: string;
  target?: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  logStage: ProviderErrorStageLogger;
  stageHint?: RequestExecutorProviderErrorStage;
  extraDetails?: Record<string, unknown>;
};
