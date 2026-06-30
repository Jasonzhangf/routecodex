import type { ModuleDependencies } from '../../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ProviderProtocol } from '../types.js';
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
import type {
  RetryErrorSnapshot
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
  defaultTierAvailable?: boolean;
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
    switchAction: 'exclude_and_reroute';
    decisionLabel?: string;
    retryExecutionPolicyReason?: string;
    stage?: 'provider.runtime_resolve' | 'provider.send';
    runtimeScopeExcludedCount?: number;
  }) => void;
  forcedRouteHint?: string;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  logNonBlockingError: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  extractRetryErrorSnapshot: (error: unknown) => RetryErrorSnapshot;
};

export type RequestExecutorProviderResolveFailureResult = {
  lastError: unknown;
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
    routePool: args.routePoolForAttempt,
    defaultTierAvailable: args.defaultTierAvailable,
    excludedProviderKeys: args.excludedProviderKeys,
    recordAttempt: args.recordAttempt,
    logStage: args.logStage,
    routeHint: args.forcedRouteHint,
    forceExcludeCurrentProviderOnRetry: true,
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
  const switchWaitMs = args.consumeProviderTransportBackoffMs?.() ?? providerSwitchBackoffDelayMs;
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
  };
}
