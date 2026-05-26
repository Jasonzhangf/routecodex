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

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, fallback?: string): string | undefined;
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
  abortSignal?: AbortSignal;
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
  const suppressForceExclude =
    classification === 'special_400'
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
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
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
    extraDetails: {
      routePoolSize: Array.isArray(args.routePool) ? args.routePool.length : 0
    }
  });
  const retryTelemetryPlan =
    retryExecutionPlan.shouldRetry && retryExecutionPlan.retrySwitchPlan && retryExecutionPlan.backoffScope
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
