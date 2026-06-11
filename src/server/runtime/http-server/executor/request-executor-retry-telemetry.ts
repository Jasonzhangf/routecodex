import type {
  ProviderRetryExecutionPlan,
  ProviderRetryTelemetryPlan,
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export function emitRequestExecutorProviderRetryTelemetry(args: {
  requestId: string;
  retryTelemetryPlan: ProviderRetryTelemetryPlan;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  logProviderRetrySwitch: (args: ProviderRetryTelemetryPlan['switchLogArgs']) => void;
}): void {
  try {
    if (args.retryTelemetryPlan.runtimeScopeExcludeDetails) {
      args.logStage('provider.retry.runtime_scope_exclude', args.requestId, args.retryTelemetryPlan.runtimeScopeExcludeDetails);
    }
    args.logProviderRetrySwitch(args.retryTelemetryPlan.switchLogArgs);
    args.logStage('provider.retry', args.requestId, args.retryTelemetryPlan.retryStageDetails);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown telemetry error');
    console.warn(`[provider-retry-telemetry] failed requestId=${args.requestId} message=${JSON.stringify(message)}`);
  }
}

export function buildProviderRetryTelemetryPlan(args: {
  requestId: string;
  attempt: number;
  maxAttempts: number;
  providerKey?: string;
  retryError: RetryErrorSnapshot;
  excludedProviderKeys: Set<string>;
  routeHint?: string;
  retryExecutionPlan: ProviderRetryExecutionPlan;
  stage: 'provider.runtime_resolve' | 'provider.send';
  runtimeKey?: string;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
}): ProviderRetryTelemetryPlan {
  if (!args.retryExecutionPlan.retrySwitchPlan || !args.retryExecutionPlan.backoffScope) {
    throw new Error('retry telemetry requires retrySwitchPlan/backoffScope');
  }
  const retrySwitchPlan = args.retryExecutionPlan.retrySwitchPlan;
  const nextAttempt = Math.max(args.attempt, Math.min(args.maxAttempts, args.attempt + 1));
  const switchLogArgs = {
    requestId: args.requestId,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    providerKey: args.providerKey,
    nextAttempt,
    reason: args.retryError.reason,
    backoffMs: args.retryExecutionPlan.retryBackoffMs,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    upstreamStatus: args.retryError.upstreamStatus,
    switchAction: retrySwitchPlan.switchAction,
    backoffScope: args.retryExecutionPlan.backoffScope,
    decisionLabel: retrySwitchPlan.decisionLabel,
    retryExecutionPolicyReason: args.retryExecutionPlan.retryExecutionPolicyReason,
    stage: args.stage,
    runtimeScopeExcludedCount: retrySwitchPlan.runtimeScopeExcludedCount
  } as ProviderRetryTelemetryPlan['switchLogArgs'];
  const retryStageDetails: Record<string, unknown> = {
    providerKey: args.providerKey,
    attempt: args.attempt,
    nextAttempt,
    excluded: Array.from(args.excludedProviderKeys),
    reason: args.retryError.reason,
    routeHint: args.routeHint,
    switchAction: retrySwitchPlan.switchAction,
    ...(typeof args.retryError.statusCode === 'number' ? { statusCode: args.retryError.statusCode } : {}),
    ...(args.retryError.errorCode ? { errorCode: args.retryError.errorCode } : {}),
    ...(args.retryError.upstreamCode ? { upstreamCode: args.retryError.upstreamCode } : {}),
    ...(typeof args.retryError.upstreamStatus === 'number' ? { upstreamStatus: args.retryError.upstreamStatus } : {}),
    retryBackoffMs: args.retryExecutionPlan.retryBackoffMs,
    recoverableBackoffMs: args.retryExecutionPlan.recoverableBackoffMs,
    backoffScope: args.retryExecutionPlan.backoffScope,
    decisionLabel: retrySwitchPlan.decisionLabel,
    retryExecutionPolicyReason: args.retryExecutionPlan.retryExecutionPolicyReason,
    ...(retrySwitchPlan.runtimeScopeExcludedCount > 0
      ? { runtimeScopeExcludedCount: retrySwitchPlan.runtimeScopeExcludedCount }
      : {}),
    holdOnLastAvailable429: args.retryExecutionPlan.holdOnLastAvailable429,
    blockingRecoverable: args.retryExecutionPlan.blockingRecoverable,
    ...(args.promptTooLong
      ? {
        contextOverflowRetries: args.contextOverflowRetries,
        maxContextOverflowRetries: args.maxContextOverflowRetries
      }
      : {})
  };
  const runtimeScopeExcludeDetails = retrySwitchPlan.runtimeScopeExcluded.length > 0
    ? {
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      excludedRuntimeScope: retrySwitchPlan.runtimeScopeExcluded,
      attempt: args.attempt
    }
    : undefined;
  return {
    switchLogArgs,
    retryStageDetails,
    runtimeScopeExcludeDetails
  };
}
