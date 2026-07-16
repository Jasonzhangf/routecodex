import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderProtocol } from '../types.js';
import {
  trafficGovernorObserveOutcome
} from '../../../../modules/traffic-governor/index.js';
import {
  emitRequestExecutorProviderRetryTelemetry
} from './request-executor-retry-telemetry.js';
import {
  resolveRequestExecutorProviderFailurePlan
} from './request-executor-provider-failure-plan.js';
import {
  recordProviderTransportBackoff,
  recordProviderSwitchBackoff,
  resolveProviderTransportBackoffScopeKey,
  resolveProviderSwitchBackoffScopeKey,
  waitProviderSwitchBackoffWithGate
} from './request-executor-error-action-queue.js';
import {
  extractStatusCodeFromError,
} from './request-retry-helpers.js';
import { isPromptTooLongError } from './retry-engine.js';
import { isClientDisconnectAbortError } from '../executor-provider.js';
import {
  attachProviderObservationToError,
  attachRetryErrorSnapshotToError,
  extractRequestExecutorProviderErrorStage
} from './request-executor-error-shared.js';
import type {
  ProviderRetryExecutionPlan,
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
  routecodexRoutingPolicyGroup?: string;
  runtimeKey?: string;
  target: Record<string, unknown>;
  dependencies: ModuleDependencies;
  runtimeManager: {
    resolveRuntimeKey(providerKey?: string, metadata?: Record<string, unknown>): string | undefined;
  };
  attempt: number;
  maxAttempts: number;
  logicalRequestChainKey: string;
  routePoolForAttempt?: string[];
  routePoolIsAuthoritative?: boolean;
  defaultTierAvailable?: boolean;
  defaultPoolSingletonProvider?: boolean;
  excludedProviderKeys: Set<string>;
  portScope?: string;
  providerTransportBackoffKey?: string;
  consumeProviderTransportBackoffMs?: () => number;
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
    upstreamStatus?: number;
    catalogCode?: string;
    catalogKey?: string;
    switchAction: 'exclude_and_reroute';
    decisionLabel?: string;
    retryExecutionPolicyReason?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  }) => void;
  bypassTrafficGovernor: boolean;
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
  extraDetails?: Record<string, unknown>;
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

function createNonProjectableProviderRetryStoppedError(args: {
  requestId: string;
  providerKey: string;
  routeName?: string;
  retryError: RetryErrorSnapshot;
  retryExecutionPlan: ProviderRetryExecutionPlan;
}): Error {
  return Object.assign(
    new Error('Provider retry stopped before client projection; default pool remains available but no request-local retry candidate remains'),
    {
      code: 'ROUTECODEX_PROVIDER_RETRY_STOPPED',
      statusCode: 502,
      status: 502,
      upstreamMessage: 'Provider retry candidates exhausted before client projection',
      requestId: args.requestId,
      providerKey: args.providerKey,
      routeName: args.routeName,
      details: {
        code: 'ROUTECODEX_PROVIDER_RETRY_STOPPED',
        status: 502,
        retryStoppedEvidence: {
          upstreamCode: args.retryError.errorCode ?? args.retryError.upstreamCode,
          upstreamStatus: args.retryError.statusCode,
        },
        providerKey: args.providerKey,
        routeName: args.routeName,
        defaultPoolAvailable: args.retryExecutionPlan.defaultPoolAvailable,
        policyExhausted: args.retryExecutionPlan.policyExhausted,
        mayProject: args.retryExecutionPlan.mayProject,
        routePoolRemainingAfterExclusion: args.retryExecutionPlan.routePoolRemainingAfterExclusion,
      }
    }
  );
}

export type RequestExecutorProviderSendFailureResult = {
  lastError: unknown;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  cumulativeExternalLatencyMs: number;
  allowRetryBeyondAttemptBudget?: boolean;
  retryExecutionPlan?: ProviderRetryExecutionPlan;
};

async function observeFailedTrafficOutcome(args: {
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
}): Promise<void> {
  trafficGovernorObserveOutcome({
    runtimeKey: args.runtimeKey,
    providerKey: args.providerKey,
    requestId: args.requestId,
    success: false,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    activeInFlight: args.activeInFlight,
  });
}

export async function processProviderSendFailure(
  args: RequestExecutorProviderSendFailureArgs
): Promise<RequestExecutorProviderSendFailureResult> {
  if (args.abortSignal?.aborted || isClientDisconnectAbortError(args.error)) {
    throw args.error;
  }
  const retryError = args.extractRetryErrorSnapshot(args.error);
  attachRetryErrorSnapshotToError(args.error, retryError);
  attachProviderObservationToError(args.error, {
    providerKey: args.providerKey,
    providerModel: args.providerModel
  });
  const resolvedFailureStage =
    extractRequestExecutorProviderErrorStage(args.error)
    ?? 'provider.send';
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
          runtimeKey: args.runtimeKey,
          providerKey: args.providerKey,
          requestId: args.requestId,
          retryError,
          activeInFlight: args.trafficActiveInFlightAtAcquire,
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
    ...(typeof retryError.upstreamStatus === 'number' ? { upstreamStatus: retryError.upstreamStatus } : {}),
    ...(retryError.catalogCode ? { catalogCode: retryError.catalogCode } : {}),
    ...(retryError.catalogKey ? { catalogKey: retryError.catalogKey } : {}),
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
        upstreamStatus: retryError.upstreamStatus ?? null,
        catalogCode: retryError.catalogCode ?? null,
        catalogKey: retryError.catalogKey ?? null,
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
    routecodexRoutingPolicyGroup: args.routecodexRoutingPolicyGroup,
    runtimeKey: args.runtimeKey,
    target: args.target,
    dependencies: args.dependencies,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    stage: resolvedFailureStage === 'provider.runtime_resolve' ? 'provider.runtime_resolve' : 'provider.send',
    logicalRequestChainKey: args.logicalRequestChainKey,
    logicalChainRetryLimitStageRequestId: args.requestId,
    routePool: args.routePoolForAttempt,
    routePoolIsAuthoritative: args.routePoolIsAuthoritative,
    defaultTierAvailable: args.defaultTierAvailable,
    defaultPoolSingletonProvider: args.defaultPoolSingletonProvider,
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
    extraDetails: args.extraDetails,
    logNonBlockingError: args.logNonBlockingError
  });
  const retryExecutionPlan = providerFailurePlan.retryExecutionPlan;
  if (!retryExecutionPlan.shouldRetry) {
    if (
      retryExecutionPlan.mayProject !== true
      && retryExecutionPlan.defaultPoolAvailable === true
    ) {
      throw createNonProjectableProviderRetryStoppedError({
        requestId: args.requestId,
        providerKey: args.providerKey,
        routeName: args.routeName,
        retryError,
        retryExecutionPlan
      });
    }
    throw args.error;
  }
  if (retryExecutionPlan.retrySwitchPlan) {
    if (!providerFailurePlan.retryTelemetryPlan) {
      throw args.error;
    }
    emitRequestExecutorProviderRetryTelemetry({
      requestId: args.requestId,
      retryTelemetryPlan: providerFailurePlan.retryTelemetryPlan,
      logStage: args.logStage,
      logProviderRetrySwitch: args.logProviderRetrySwitch
    });
  }

  const providerTransportBackoffScopeKey = resolveProviderTransportBackoffScopeKey({
    providerTransportBackoffKey: args.providerTransportBackoffKey,
    portScope: args.portScope,
    metadata: args.metadata,
    providerKey: args.providerKey
  });
  const transportBackoffDelayMs = recordProviderTransportBackoff({
    providerTransportBackoffKey: providerTransportBackoffScopeKey
  });
  args.logStage('provider.transport_backoff.recorded', args.requestId, {
    providerKey: args.providerKey,
    scopeKey: providerTransportBackoffScopeKey,
    delayMs: transportBackoffDelayMs,
    attempt: args.attempt
  });
  const providerSwitchBackoffScopeKey = resolveProviderSwitchBackoffScopeKey({
    portScope: args.portScope,
    metadata: args.metadata,
    routeName: args.routeName
  });
  const providerSwitchBackoffDelayMs = recordProviderSwitchBackoff({
    providerSwitchBackoffKey: providerSwitchBackoffScopeKey
  });
  args.logStage('provider.switch_backoff.recorded', args.requestId, {
    providerKey: args.providerKey,
    routeName: args.routeName,
    scopeKey: providerSwitchBackoffScopeKey,
    delayMs: providerSwitchBackoffDelayMs,
    attempt: args.attempt
  });
  const consumedTransportWaitMs = args.consumeProviderTransportBackoffMs?.();
  const switchWaitMs =
    typeof consumedTransportWaitMs === 'number' && Number.isFinite(consumedTransportWaitMs)
      ? Math.max(0, consumedTransportWaitMs, providerSwitchBackoffDelayMs)
      : providerSwitchBackoffDelayMs;
  if (switchWaitMs > 0) {
    args.logStage('provider.switch_backoff_wait', args.requestId, {
      providerKey: args.providerKey,
      routeName: args.routeName,
      scopeKey: providerSwitchBackoffScopeKey,
      waitMs: switchWaitMs,
      attempt: args.attempt
    });
    await waitProviderSwitchBackoffWithGate({
      providerSwitchBackoffKey: providerSwitchBackoffScopeKey,
      ms: switchWaitMs,
      signal: args.abortSignal,
      logNonBlockingError: args.logNonBlockingError
    });
    args.logStage('provider.switch_backoff_wait.completed', args.requestId, {
      providerKey: args.providerKey,
      routeName: args.routeName,
      scopeKey: providerSwitchBackoffScopeKey,
      waitMs: switchWaitMs,
      attempt: args.attempt
    });
  }

  return {
    lastError: args.error,
    forcedRouteHint,
    contextOverflowRetries,
    cumulativeExternalLatencyMs,
    allowRetryBeyondAttemptBudget: retryExecutionPlan.allowRetryBeyondAttemptBudget === true,
    retryExecutionPlan
  };
}
