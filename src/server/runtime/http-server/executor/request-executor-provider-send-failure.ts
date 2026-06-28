import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderProtocol } from '../types.js';
import type { ProviderTrafficGovernorLike } from '../provider-traffic-governor.js';
import {
  emitRequestExecutorProviderRetryTelemetry
} from './request-executor-retry-telemetry.js';
import {
  resolveRequestExecutorProviderFailurePlan
} from './request-executor-provider-failure-plan.js';
import {
  extractStatusCodeFromError,
} from './request-retry-helpers.js';
import { isPromptTooLongError } from './retry-engine.js';
import { isClientDisconnectAbortError } from '../executor-provider.js';
import { remapBridgeSseErrorToHttp } from './provider-response-sse-error-normalizer.js';
import { extractRequestExecutorProviderErrorStage } from './request-executor-error-shared.js';
import type {
  RetryErrorSnapshot
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
  defaultTierAvailable?: boolean;
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
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    switchAction: 'exclude_and_reroute';
    decisionLabel?: string;
    retryExecutionPolicyReason?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  }) => void;
  bypassTrafficGovernor: boolean;
  trafficGovernor: ProviderTrafficGovernorLike;
  trafficActiveInFlightAtAcquire: number;
  trafficPolicyMaxInFlight: number;
  providerSendStartedAtMs: number;
  providerSendElapsedMs: number;
  cumulativeExternalLatencyMs: number;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  maxContextOverflowRetries: number;
  isStreamingRequest?: boolean;
  providerOwnedContinuation?: boolean;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  phase: 'provider_send' | 'provider_response_processing';
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  extractRetryErrorSnapshot: (error: unknown) => RetryErrorSnapshot;
  writeProviderSnapshot: (args: {
    phase: 'provider-error';
    requestId: string;
    data: unknown;
    headers?: Record<string, unknown>;
    url?: string;
    entryEndpoint?: string;
    clientRequestId?: string;
    providerKey?: string;
    providerId?: string;
    forceLocalDiskWriteWhenDisabled?: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
};

export type RequestExecutorProviderSendFailureResult = {
  lastError: unknown;
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
    status?: unknown;
    statusCode?: unknown;
    requestExecutorProviderErrorStage?: unknown;
  };
  if (typeof record.requestExecutorProviderErrorStage !== 'string') {
    const message = args.error instanceof Error ? args.error.message : String(args.error ?? '');
    remapBridgeSseErrorToHttp(record as Record<string, unknown>, message);
  }
  const statusCode = typeof record.statusCode === 'number'
    ? record.statusCode
    : (typeof record.status === 'number' ? record.status : args.retryError.statusCode);
  if (
    record.requestExecutorProviderErrorStage === 'provider.http'
    && typeof statusCode === 'number'
    && (
      statusCode === 401
      || statusCode === 402
      || statusCode === 403
      || statusCode === 408
      || statusCode === 425
      || statusCode === 429
      || statusCode >= 500
    )
  ) {
    return true;
  }
  if (record.requestExecutorProviderErrorStage === 'provider.responses') {
    return true;
  }
  if (
    record.retryable === true
    && record.requestExecutorProviderErrorStage === 'host.response_contract'
    && (
      args.retryError.errorCode === 'EMPTY_ASSISTANT_RESPONSE'
      || args.retryError.errorCode === 'MISSING_REQUIRED_TOOL_CALL'
    )
  ) {
    return true;
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
  const resolvedFailureStage =
    extractRequestExecutorProviderErrorStage(args.error)
    ?? (args.phase === 'provider_response_processing' ? 'provider.send' : 'provider.send');
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

  try {
    await args.writeProviderSnapshot({
      phase: 'provider-error',
      requestId: args.requestId,
      data: {
        message: errorMessage,
        status: retryError.statusCode ?? extractStatusCodeFromError(args.error) ?? null,
        code: retryError.errorCode ?? (args.error && typeof args.error === 'object' ? (args.error as { code?: unknown }).code : null) ?? null,
        upstreamCode: retryError.upstreamCode ?? null,
        requestExecutorProviderErrorStage: resolvedFailureStage,
        reason: retryError.reason,
        providerKey: args.providerKey,
        providerId: args.providerId,
        providerType: args.providerType,
        providerFamily: args.providerFamily,
        providerProtocol: args.providerProtocol,
        providerModel: args.providerModel,
        routeName: args.routeName,
        runtimeKey: args.runtimeKey,
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
        logicalRequestChainKey: args.logicalRequestChainKey,
        phase: args.phase
      },
      headers: (args.metadata && typeof args.metadata === 'object' ? (args.metadata as Record<string, unknown>).headers as Record<string, unknown> | undefined : undefined),
      url: undefined,
      entryEndpoint: typeof (args.metadata as Record<string, unknown> | undefined)?.entryEndpoint === 'string'
        ? (args.metadata as Record<string, unknown>).entryEndpoint as string
        : undefined,
      clientRequestId: typeof (args.metadata as Record<string, unknown> | undefined)?.clientRequestId === 'string'
        ? (args.metadata as Record<string, unknown>).clientRequestId as string
        : undefined,
      providerKey: args.providerKey,
      providerId: args.providerId,
      metadata: args.metadata
    });
  } catch (snapshotError) {
    args.logNonBlockingError('writeProviderSnapshot(provider-error)', snapshotError, {
      requestId: args.requestId,
      providerKey: args.providerKey,
      phase: args.phase
    });
  }

  const status =
    typeof retryError.statusCode === 'number'
      ? retryError.statusCode
      : extractStatusCodeFromError(args.error);
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
    stage: resolvedFailureStage === 'provider.runtime_resolve' ? 'provider.runtime_resolve' : 'provider.send',
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.requestId,
    routePool: args.routePoolForAttempt,
    defaultTierAvailable: args.defaultTierAvailable,
    runtimeManager: args.runtimeManager,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    routeHint: forcedRouteHint,
    promptTooLong,
    contextOverflowRetries,
    maxContextOverflowRetries: args.maxContextOverflowRetries,
    status,
    isStreamingRequest: args.isStreamingRequest,
    providerOwnedContinuation: args.providerOwnedContinuation,
    abortSignal: args.abortSignal,
    metadata: args.metadata,
    logNonBlockingError: args.logNonBlockingError
  });
  const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
  if (!retryExecutionPlan.shouldRetry || !retryExecutionPlan.retrySwitchPlan) {
    throw args.error;
  }
  if (!providerFailurePlan.retryTelemetryPlan) {
    throw args.error;
  }
  emitRequestExecutorProviderRetryTelemetry({
    requestId: args.requestId,
    retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
    logStage: args.logStage,
    logProviderRetrySwitch: args.logProviderRetrySwitch
  });

  return {
    lastError: args.error,
    forcedRouteHint,
    contextOverflowRetries,
    cumulativeExternalLatencyMs
  };
}
