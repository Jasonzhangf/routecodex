import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderFailurePlan,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import type {
  RequestExecutorProviderErrorStage
} from './request-executor-error-types.js';
import {
  buildProviderRetryTelemetryPlan
} from './request-executor-retry-telemetry.js';
import {
  resolveProviderFailureClassification,
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  reportRequestExecutorProviderError,
  resolveRequestExecutorProviderErrorReportPlan
} from './request-executor-provider-failure.js';
import {
  resolveProviderRetryExecutionPlan
} from './request-executor-retry-execution-plan.js';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export async function resolveRequestExecutorProviderFailurePlan(args: {
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
  maxAttempts: number;
  stage: 'provider.runtime_resolve' | 'provider.send';
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  runtimeManager?: RuntimeManager;
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  routeHint?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  status?: number;
  forceExcludeCurrentProviderOnRetry?: boolean;
  defaultTierAvailable?: boolean;
  isStreamingRequest?: boolean;
  providerOwnedContinuation?: boolean;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  extraDetails?: Record<string, unknown>;
  logNonBlockingError: LogNonBlockingError;
}): Promise<RequestExecutorProviderFailurePlan> {
  const reportPlan = resolveRequestExecutorProviderErrorReportPlan({
    error: args.error,
    retryError: args.retryError,
    stage: args.stage
  });
  const topCode = typeof (args.error as { code?: unknown } | undefined)?.code === 'string'
    ? String((args.error as { code: string }).code).trim().toUpperCase()
    : undefined;
  const topUpstreamCode = typeof (args.error as { upstreamCode?: unknown } | undefined)?.upstreamCode === 'string'
    ? String((args.error as { upstreamCode: string }).upstreamCode).trim().toUpperCase()
    : undefined;
  const errorCode = typeof args.retryError.errorCode === 'string'
    ? args.retryError.errorCode.trim().toUpperCase()
    : undefined;
  const upstreamCode = typeof args.retryError.upstreamCode === 'string'
    ? args.retryError.upstreamCode.trim().toUpperCase()
    : undefined;
  const classification = resolveProviderFailureClassification({
    error: args.error,
    stage: reportPlan.stageHint,
    statusCode: reportPlan.statusCode,
    errorCode: reportPlan.errorCode,
    upstreamCode: reportPlan.upstreamCode,
    reason: args.retryError.reason
  });
  const suppressForceExclude =
    topCode === 'CLIENT_TOOL_ARGS_INVALID'
    || topUpstreamCode === 'CLIENT_TOOL_ARGS_INVALID'
    || errorCode === 'CLIENT_TOOL_ARGS_INVALID'
    || upstreamCode === 'CLIENT_TOOL_ARGS_INVALID'
    || reportPlan.stageHint === 'host.response_contract'
    || reportPlan.stageHint === 'provider.followup';
  const forceExcludeCurrentProviderOnRetry =
    suppressForceExclude
      ? false
      : args.forceExcludeCurrentProviderOnRetry === true;
  const retryExecutionPlan = await resolveProviderRetryExecutionPlan({
    error: args.error,
    retryError: args.retryError,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: reportPlan.stageHint as RequestExecutorProviderErrorStage,
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.logicalChainRetryLimitStageRequestId,
    routePool: args.routePool,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    status: args.status,
    forceExcludeCurrentProviderOnRetry,
    defaultTierAvailable: args.defaultTierAvailable,
    isStreamingRequest: args.isStreamingRequest,
    providerOwnedContinuation: args.providerOwnedContinuation,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  const reportStage = reportPlan.stageHint;
  try {
    await reportRequestExecutorProviderError({
      error: args.error,
      retryError: args.retryError,
      requestId: args.requestId,
      providerKey: args.providerKey,
      providerId: args.providerId,
      providerType: args.providerType,
      providerFamily: args.providerFamily,
      providerProtocol: args.providerProtocol,
      routeName: args.routeName,
      runtimeKey: args.runtimeKey,
      target: args.target,
      dependencies: args.dependencies,
      attempt: args.attempt,
      logStage: args.logStage,
      stageHint: reportStage,
      metadata: args.metadata,
      routePool: args.routePool,
      excludedProviderKeys: args.excludedProviderKeys,
      extraDetails: args.extraDetails
    });
  } catch (reportError) {
    args.logNonBlockingError('request_executor.provider_error_report.failed', reportError, {
      requestId: args.requestId,
      providerKey: args.providerKey,
      stageHint: reportStage
    });
  }
  const retryTelemetryPlan =
    retryExecutionPlan.shouldRetry && retryExecutionPlan.retrySwitchPlan
      ? buildProviderRetryTelemetryPlan({
        requestId: args.requestId,
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
        providerKey: args.providerKey,
        retryError: args.retryError,
        excludedProviderKeys: args.excludedProviderKeys,
        routeHint: args.routeHint,
        retryExecutionPlan,
        stage: args.stage,
        runtimeKey: args.runtimeKey,
        promptTooLong: args.promptTooLong,
        contextOverflowRetries: args.contextOverflowRetries,
        maxContextOverflowRetries: args.maxContextOverflowRetries
      })
      : undefined;
  return {
    reportPlan,
    retryExecutionPlan,
    ...(retryTelemetryPlan ? { retryTelemetryPlan } : {})
  };
}
