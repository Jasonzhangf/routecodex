import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderProtocol } from '../types.js';
import type { ProviderTrafficGovernorLike } from '../provider-traffic-governor.js';
import {
  emitRequestExecutorProviderRetryTelemetry,
  peekProviderTransportBackoffConsecutiveForTests
} from './request-executor-retry-planner.js';
import {
  resolveRequestExecutorProviderFailurePlan
} from './request-executor-provider-failure-plan.js';
import {
  extractStatusCodeFromError,
} from './request-retry-helpers.js';
import { isPromptTooLongError } from './retry-engine.js';
import { shouldApplyProviderTransportBackoff } from './request-executor-provider-failure.js';
import { isClientDisconnectAbortError } from '../executor-provider.js';
import { remapBridgeSseErrorToHttp } from './provider-response-sse-error-normalizer.js';
import type {
  RetryErrorSnapshot,
  BlockingRecoverableRouteHoldState
} from './request-executor-error-types.js';

type RequestExecutorProviderSendFailureArgs = {
  error: unknown;
  requestId: string;
  providerKey: string;
  providerId: string;
  providerType?: string;
  providerFamily?: string;
  providerProtocol: ProviderProtocol;
  providerModel?: string;
  providerLabel?: string;
  routeName?: string;
  runtimeKey?: string;
  target: Record<string, unknown>;
  dependencies: ModuleDependencies;
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, fallback?: string, metadata?: Record<string, unknown>): string | undefined;
  };
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
  bypassTrafficGovernor: boolean;
  trafficGovernor: ProviderTrafficGovernorLike;
  trafficActiveInFlightAtAcquire: number;
  trafficPolicyMaxInFlight: number;
  providerTransportBackoffKey?: string;
  consumeProviderTransportBackoffMs: (key: string, args: { error: unknown; statusCode?: number }) => number;
  sessionStormBackoffScopes?: string[];
  isSessionStormBackoffCandidate: (error: unknown) => boolean;
  consumeSessionStormBackoffMs: (key: string, error?: unknown) => number;
  getSessionStormBackoffConsecutive: (key: string) => number;
  providerSendStartedAtMs: number;
  providerSendElapsedMs: number;
  cumulativeExternalLatencyMs: number;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  maxContextOverflowRetries: number;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  phase: 'provider_send' | 'provider_response_processing';
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  extractRetryErrorSnapshot: (error: unknown) => RetryErrorSnapshot;
};

export type RequestExecutorProviderSendFailureResult = {
  lastError: unknown;
  blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
  allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  cumulativeExternalLatencyMs: number;
};

function isRetryableProviderResponseProcessingFailure(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
}): boolean {
  if (!args.error || typeof args.error !== 'object') {
    return false;
  }
  const record = args.error as {
    code?: unknown;
    upstreamCode?: unknown;
    retryable?: unknown;
    requestExecutorProviderErrorStage?: unknown;
  };
  if (typeof record.requestExecutorProviderErrorStage !== 'string') {
    const message = args.error instanceof Error ? args.error.message : String(args.error ?? '');
    remapBridgeSseErrorToHttp(record as Record<string, unknown>, message);
  }
  return record.retryable === true
    && record.requestExecutorProviderErrorStage === 'provider.sse_decode'
    && (
      args.retryError.errorCode === 'SSE_DECODE_ERROR'
      || record.code === 'SSE_DECODE_ERROR'
      || args.retryError.upstreamCode === 'UPSTREAM_STREAM_TERMINATED'
      || record.upstreamCode === 'UPSTREAM_STREAM_TERMINATED'
    );
}

async function observeFailedTrafficOutcome(args: {
  governor: ProviderTrafficGovernorLike;
  runtimeKey: string;
  providerKey: string;
  requestId: string;
  retryError: {
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    reason: string;
  };
  activeInFlight: number;
  configuredMaxInFlight?: number;
}): Promise<void> {
  await args.governor.observeOutcome?.({
    runtimeKey: args.runtimeKey,
    providerKey: args.providerKey,
    requestId: args.requestId,
    success: false,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    activeInFlight: args.activeInFlight,
    configuredMaxInFlight: args.configuredMaxInFlight
  });
}

export async function processProviderSendFailure(
  args: RequestExecutorProviderSendFailureArgs
): Promise<RequestExecutorProviderSendFailureResult> {
  if (args.abortSignal?.aborted || isClientDisconnectAbortError(args.error)) {
    throw args.error;
  }
  const retryError = args.extractRetryErrorSnapshot(args.error);
  if (
    args.phase !== 'provider_send'
    && !isRetryableProviderResponseProcessingFailure({
      error: args.error,
      retryError
    })
  ) {
    throw args.error;
  }
  let cumulativeExternalLatencyMs = args.cumulativeExternalLatencyMs;
  if (args.providerSendStartedAtMs > 0 && args.providerSendElapsedMs <= 0) {
    const failedSendElapsedMs = Math.max(0, Date.now() - args.providerSendStartedAtMs);
    if (failedSendElapsedMs > 0) {
      cumulativeExternalLatencyMs += failedSendElapsedMs;
      args.logStage('provider.send.failed_elapsed', args.requestId, {
        providerKey: args.providerKey,
        elapsedMs: failedSendElapsedMs,
        attempt: args.attempt
      });
    }
  }

  const errorMessage = args.error instanceof Error ? args.error.message : String(args.error ?? 'Unknown error');
  if (args.sessionStormBackoffScopes?.length && args.isSessionStormBackoffCandidate(args.error)) {
    for (const scope of args.sessionStormBackoffScopes) {
      const backoffMs = args.consumeSessionStormBackoffMs(scope, args.error);
      args.logStage('request.session_storm_backoff.recorded', args.requestId, {
        scope,
        backoffMs,
        consecutive: args.getSessionStormBackoffConsecutive(scope),
        reason: retryError.reason,
        errorCode: retryError.errorCode,
        upstreamCode: retryError.upstreamCode,
        statusCode: retryError.statusCode
      });
    }
  }

  if (!args.bypassTrafficGovernor) {
    try {
      if (args.runtimeKey) {
        await observeFailedTrafficOutcome({
          governor: args.trafficGovernor,
          runtimeKey: args.runtimeKey,
          providerKey: args.providerKey,
          requestId: args.requestId,
          retryError,
          activeInFlight: args.trafficActiveInFlightAtAcquire,
          configuredMaxInFlight: args.trafficPolicyMaxInFlight || undefined
        });
      }
    } catch (observeError) {
      args.logStage('provider.traffic.observe_outcome.error', args.requestId, {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        message:
          observeError instanceof Error
            ? observeError.message
            : String(observeError ?? 'Unknown observe outcome error'),
        attempt: args.attempt
      });
    }
  }

  args.logStage('provider.send.error', args.requestId, {
    providerKey: args.providerKey,
    message: errorMessage,
    providerType: args.providerType,
    providerFamily: args.providerFamily,
    model: args.providerModel,
    providerLabel: args.providerLabel,
    ...(typeof retryError.statusCode === 'number' ? { statusCode: retryError.statusCode } : {}),
    ...(retryError.errorCode ? { errorCode: retryError.errorCode } : {}),
    ...(retryError.upstreamCode ? { upstreamCode: retryError.upstreamCode } : {}),
    attempt: args.attempt
  });

  const status =
    typeof retryError.statusCode === 'number'
      ? retryError.statusCode
      : extractStatusCodeFromError(args.error);
  if (
    args.providerTransportBackoffKey
    && shouldApplyProviderTransportBackoff({
      error: args.error,
      retryError,
      stage: 'provider.send'
    })
  ) {
    const providerBackoffMs = args.consumeProviderTransportBackoffMs(args.providerTransportBackoffKey, {
      error: args.error,
      statusCode: status
    });
    args.logStage('provider.transport_backoff.recorded', args.requestId, {
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      backoffKey: args.providerTransportBackoffKey,
      backoffMs: providerBackoffMs,
      consecutive: peekProviderTransportBackoffConsecutiveForTests(args.providerTransportBackoffKey),
      reason: retryError.reason,
      errorCode: retryError.errorCode,
      upstreamCode: retryError.upstreamCode,
      statusCode: status,
      attempt: args.attempt
    });
  }

  const promptTooLong = isPromptTooLongError(args.error);
  const forcedRouteHint = promptTooLong && args.forcedRouteHint !== 'longcontext'
    ? 'longcontext'
    : args.forcedRouteHint;
  const contextOverflowRetries = promptTooLong
    ? args.contextOverflowRetries + 1
    : args.contextOverflowRetries;

  const providerFailurePlan = await resolveRequestExecutorProviderFailurePlan({
    error: args.error,
    retryError,
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
    maxAttempts: args.maxAttempts,
    stage: 'provider.send',
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.requestId,
    routePool: args.routePoolForAttempt,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    routeHint: forcedRouteHint,
    promptTooLong,
    contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    status,
    abortSignal: args.abortSignal,
    metadata: args.metadata,
    logNonBlockingError: args.logNonBlockingError
  });
  const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
  if (!retryExecutionPlan.shouldRetry || !retryExecutionPlan.retrySwitchPlan || !retryExecutionPlan.backoffScope) {
    throw args.error;
  }
  if (!providerFailurePlan.retryTelemetryPlan) {
    throw args.error;
  }

  const shouldPreserveSameProviderRetry = retryExecutionPlan.retrySwitchPlan?.switchAction === 'retry_same_provider';
  const blockingRecoverableRouteHoldState =
    (retryExecutionPlan.blockingRecoverable || shouldPreserveSameProviderRetry)
      ? {
        providerKey: args.providerKey,
        runtimeKey: args.runtimeKey,
        retryError,
        holdOnLastAvailable429: retryExecutionPlan.holdOnLastAvailable429,
        explicitSingletonPool: Array.isArray(args.routePoolForAttempt) && args.routePoolForAttempt.length === 1,
        preserveSameProviderRetry: shouldPreserveSameProviderRetry,
        routePoolForSameProviderRetry: Array.isArray(args.routePoolForAttempt) ? [...args.routePoolForAttempt] : undefined
      }
      : null;
  const allowBlockingRecoverableRetryBeyondAttemptBudget =
    args.attempt >= args.maxAttempts
    && (
      retryExecutionPlan.blockingRecoverable
      || (retryExecutionPlan.excludedCurrentProvider && retryExecutionPlan.shouldRetry)
    );

  emitRequestExecutorProviderRetryTelemetry({
    requestId: args.requestId,
    retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
    logStage: args.logStage,
    logProviderRetrySwitch: args.logProviderRetrySwitch
  });

  return {
    lastError: args.error,
    blockingRecoverableRouteHoldState,
    allowBlockingRecoverableRetryBeyondAttemptBudget,
    forcedRouteHint,
    contextOverflowRetries,
    cumulativeExternalLatencyMs
  };
}
