import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderFailurePlan,
  RequestLocalTransientRetryTracker,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import type {
  RequestExecutorProviderErrorStage
} from './request-executor-error-types.js';
import {
  buildProviderRetryTelemetryPlan
} from './request-executor-retry-telemetry.js';
import {
  reportRequestExecutorProviderError,
  resolveRequestExecutorProviderErrorReportPlan
} from './request-executor-provider-failure.js';
import {
  resolveProviderRetryExecutionPlan
} from './request-executor-retry-execution-plan.js';
import {
  cloneErrorForReporting
} from './request-executor-error-report.js';
import {
  resolveRequestExecutorProviderErrorClassification
} from './request-executor-provider-failure.js';
import {
  shouldSuppressForcedProviderExclusion
} from '../../../../providers/core/runtime/provider-failure-policy.js';

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
  transientRetryTracker?: RequestLocalTransientRetryTracker;
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
  const classification = resolveRequestExecutorProviderErrorClassification({
    error: args.error,
    retryError: args.retryError,
    stage: reportPlan.stageHint as RequestExecutorProviderErrorStage
  });
  const suppressForceExclude = shouldSuppressForcedProviderExclusion({
    classification,
    stage: reportPlan.stageHint
  });
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
    transientRetryTracker: args.transientRetryTracker,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  try {
    await reportRequestExecutorProviderError({
      error: cloneErrorForReporting(args.error),
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
      stageHint: reportPlan.stageHint,
      metadata: args.metadata,
      routePool: args.routePool,
      excludedProviderKeys: args.excludedProviderKeys,
      extraDetails: {
        ...(args.extraDetails ?? {}),
        routePoolSize: Array.isArray(args.routePool) ? args.routePool.length : 0
      }
    });
  } catch (reportError) {
    args.logNonBlockingError('request_executor.provider_error_report.failed', reportError, {
      requestId: args.requestId,
      providerKey: args.providerKey,
      stageHint: reportPlan.stageHint
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
