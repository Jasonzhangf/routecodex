import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderProtocol } from '../types.js';
import {
  emitRequestExecutorProviderRetryTelemetry
} from './request-executor-retry-planner.js';
import {
  resolveRequestExecutorProviderFailurePlan
} from './request-executor-provider-failure-plan.js';
import type {
  RetryErrorSnapshot,
  BlockingRecoverableRouteHoldState
} from './request-executor-error-types.js';

type RequestExecutorProviderResolveFailureArgs = {
  error: unknown;
  requestId: string;
  providerKey: string;
  providerType?: string;
  providerProtocol: ProviderProtocol;
  routeName?: string;
  runtimeKey?: string;
  target: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  maxAttempts: number;
  logicalRequestChainKey: string;
  routePoolForAttempt?: string[];
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  logProviderRetrySwitch: (args: {
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
    switchAction: 'exclude_and_reroute' | 'retry_same_provider';
    backoffScope?: 'provider' | 'recoverable' | 'attempt';
    decisionLabel?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  }) => void;
  forcedRouteHint?: string;
  abortSignal?: AbortSignal;
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  extractRetryErrorSnapshot: (error: unknown) => RetryErrorSnapshot;
};

export type RequestExecutorProviderResolveFailureResult = {
  lastError: unknown;
  blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
  allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
};

export async function processProviderResolveFailure(
  args: RequestExecutorProviderResolveFailureArgs
): Promise<RequestExecutorProviderResolveFailureResult> {
  const errorMessage = args.error instanceof Error ? args.error.message : String(args.error ?? 'Unknown error');
  const retryError = args.extractRetryErrorSnapshot(args.error);
  args.logStage('provider.runtime_resolve.error', args.requestId, {
    providerKey: args.providerKey,
    message: errorMessage,
    ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
    ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
    ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
    attempt: args.attempt
  });

  const providerFailurePlan = await resolveRequestExecutorProviderFailurePlan({
    error: args.error,
    retryError,
    requestId: args.requestId,
    providerKey: args.providerKey,
    providerType: args.providerType,
    providerProtocol: args.providerProtocol,
    routeName: args.routeName,
    runtimeKey: args.runtimeKey,
    target: args.target,
    dependencies: args.dependencies,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: 'provider.runtime_resolve',
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.requestId,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    routeHint: args.forcedRouteHint,
    forceExcludeCurrentProviderOnRetry: true,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
  if (!retryExecutionPlan.shouldRetry || !retryExecutionPlan.retrySwitchPlan || !retryExecutionPlan.backoffScope) {
    throw args.error;
  }
  if (!providerFailurePlan.retryTelemetryPlan) {
    throw args.error;
  }

  const blockingRecoverableRouteHoldState =
    retryExecutionPlan.blockingRecoverable
      ? {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        retryError,
        holdOnLastAvailable429: retryExecutionPlan.holdOnLastAvailable429,
        explicitSingletonPool: Array.isArray(args.routePoolForAttempt) && args.routePoolForAttempt.length === 1
      }
      : null;
  const allowBlockingRecoverableRetryBeyondAttemptBudget =
    retryExecutionPlan.blockingRecoverable && args.attempt >= args.maxAttempts;

  emitRequestExecutorProviderRetryTelemetry({
    requestId: args.requestId,
    retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
    logStage: args.logStage,
    logProviderRetrySwitch: args.logProviderRetrySwitch
  });

  return {
    lastError: args.error,
    blockingRecoverableRouteHoldState,
    allowBlockingRecoverableRetryBeyondAttemptBudget
  };
}
