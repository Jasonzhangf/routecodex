import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderFailurePlan,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import {
  attachErrorErr05ExecutionDecision
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
import { emitProviderErrorAndWait } from '../../../../providers/core/utils/provider-error-reporter.js';
import {
  recordErrorActionBackoff,
  waitErrorActionBackoffWithGate
} from './request-executor-error-action-queue.js';

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, metadata?: Record<string, unknown>): string | undefined;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

function buildProviderErrorBackoffScopePrefix(args: {
  routecodexRoutingPolicyGroup?: string;
  providerKey?: string;
}): string {
  const routingGroup = buildProviderErrorBackoffLaneGroup({
    routecodexRoutingPolicyGroup: args.routecodexRoutingPolicyGroup
  });
  if (typeof args.providerKey !== 'string' || !args.providerKey.trim()) {
    throw new Error('provider action gate requires provider runtime identity truth');
  }
  return `${routingGroup}|${args.providerKey.trim()}|`;
}

export function buildProviderErrorBackoffLaneGroup(args: {
  routecodexRoutingPolicyGroup?: string;
}): string {
  if (
    typeof args.routecodexRoutingPolicyGroup !== 'string'
    || !args.routecodexRoutingPolicyGroup.trim()
  ) {
    throw new Error('provider action gate requires routecodexRoutingPolicyGroup truth');
  }
  return args.routecodexRoutingPolicyGroup.trim();
}

function buildProviderErrorBackoffScope(args: {
  routecodexRoutingPolicyGroup?: string;
  providerKey?: string;
  errorFamily: string;
}): string {
  const errorFamily = args.errorFamily.trim();
  if (!errorFamily) {
    throw new Error('provider action gate requires normalized error family truth');
  }
  return `${buildProviderErrorBackoffScopePrefix(args)}${errorFamily}`;
}

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
  routecodexRoutingPolicyGroup?: string;
  runtimeKey?: string;
  target?: Record<string, unknown>;
  dependencies: ModuleDependencies;
  attempt: number;
  maxAttempts: number;
  stage: 'provider.runtime_resolve' | 'provider.send';
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  routePoolIsAuthoritative?: boolean;
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
  defaultPoolSingletonProvider?: boolean;
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
  const retryExecutionPlan = await resolveProviderRetryExecutionPlan({
    error: args.error,
    retryError: {
      ...args.retryError,
      ...(reportPlan.statusCode !== undefined ? { statusCode: reportPlan.statusCode } : {}),
      ...(reportPlan.errorCode ? { errorCode: reportPlan.errorCode } : {}),
      ...(reportPlan.upstreamCode ? { upstreamCode: reportPlan.upstreamCode } : {}),
    },
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: reportPlan.stageHint as RequestExecutorProviderErrorStage,
    providerKey: args.providerKey,
    routeName: args.routeName,
    runtimeKey: args.runtimeKey,
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.logicalChainRetryLimitStageRequestId,
    routePool: args.routePool,
    routePoolIsAuthoritative: args.routePoolIsAuthoritative,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    promptTooLong: args.promptTooLong,
    contextOverflowRetries: args.contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    status: args.status,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry,
    defaultTierAvailable: args.defaultTierAvailable,
    defaultPoolSingletonProvider: args.defaultPoolSingletonProvider,
    isStreamingRequest: args.isStreamingRequest,
    providerOwnedContinuation: args.providerOwnedContinuation,
    abortSignal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  attachErrorErr05ExecutionDecision(args.error, retryExecutionPlan);
  if (
    retryExecutionPlan.action === 'client_disconnected'
    || retryExecutionPlan.action === 'reject_non_provider_error'
  ) {
    return {
      reportPlan,
      retryExecutionPlan,
    };
  }
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
      routecodexRoutingPolicyGroup: args.routecodexRoutingPolicyGroup,
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
  const providerErrorBackoffScope = buildProviderErrorBackoffScope({
    routecodexRoutingPolicyGroup: args.routecodexRoutingPolicyGroup,
    providerKey: args.providerKey,
    errorFamily:
      reportPlan.errorCode
      ?? reportPlan.upstreamCode
      ?? reportPlan.stageHint
  });
  const providerErrorBackoffLaneGroup = buildProviderErrorBackoffLaneGroup({
    routecodexRoutingPolicyGroup: args.routecodexRoutingPolicyGroup,
  });
  const providerErrorBackoffDelayMs = recordErrorActionBackoff({
    category: 'global_error',
    scopeKey: providerErrorBackoffScope,
    laneGroupKey: providerErrorBackoffLaneGroup,
    actionScopeKey: args.logicalRequestChainKey,
  });
  args.logStage('provider.error_action_backoff_wait', args.requestId, {
    providerKey: args.providerKey,
    routeName: args.routeName,
    stage: reportStage,
    scopeKey: providerErrorBackoffScope,
    delayMs: providerErrorBackoffDelayMs
  });
  await waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey: providerErrorBackoffScope,
    laneGroupKey: providerErrorBackoffLaneGroup,
    actionScopeKey: args.logicalRequestChainKey,
    terminalProjection: retryExecutionPlan.action === 'project_terminal',
    signal: args.abortSignal,
    logNonBlockingError: args.logNonBlockingError
  });
  args.logStage('provider.error_action_backoff_wait.completed', args.requestId, {
    providerKey: args.providerKey,
    routeName: args.routeName,
    stage: reportStage,
    scopeKey: providerErrorBackoffScope,
    delayMs: providerErrorBackoffDelayMs
  });
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
