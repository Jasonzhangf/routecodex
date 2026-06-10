import {
  resolveProviderFailureActionPlan
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import type {
  ProviderRetryBackoffPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot
} from './request-executor-error-types.js';
import {
  buildRecoverableErrorBackoffKey,
  consumeProviderScopedRetryBackoffMs,
  consumeRecoverableErrorBackoffMs,
  waitRecoverableBackoffWithGlobalGate
} from './request-executor-retry-state.js';
import {
  waitBeforeRetry
} from './retry-engine.js';

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export async function resolveProviderRetryBackoffPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  providerKey?: string;
  runtimeKey?: string;
  stage?: RequestExecutorProviderErrorStage;
  attempt: number;
  forceProviderScopedBackoff?: boolean;
  forceAttemptScopedBackoff?: boolean;
  requestLocal?: boolean;
  skipBackoffWait?: boolean;
  abortSignal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<ProviderRetryBackoffPlan> {
  const actionPlan = resolveProviderFailureActionPlan({
    error: args.error,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
    forceProviderScopedBackoff: args.forceProviderScopedBackoff,
    forceAttemptScopedBackoff: args.forceAttemptScopedBackoff,
    retryAction: 'reroute_explicit_alternative'
  });
  const blockingRecoverable = actionPlan.blockingRecoverable;
  if (args.skipBackoffWait) {
    return {
      blockingRecoverable,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
      backoffScope: actionPlan.backoff.scope === 'recoverable'
        ? 'recoverable'
        : actionPlan.backoff.scope === 'provider'
          ? 'provider'
          : 'attempt'
    };
  }
  if (args.requestLocal) {
    const retryBackoffMs = await waitBeforeRetry(args.error, {
      attempt: args.attempt,
      signal: args.abortSignal
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: retryBackoffMs,
      backoffScope: 'attempt'
    };
  }
  if (actionPlan.backoff.scope === 'attempt') {
    const retryBackoffMs = await waitBeforeRetry(args.error, {
      attempt: args.attempt,
      signal: args.abortSignal
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'attempt'
    };
  }
  if (actionPlan.backoff.scope === 'provider') {
    const providerScopedKey = buildRecoverableErrorBackoffKey({
      providerKey: args.providerKey,
      runtimeKey: args.runtimeKey,
      statusCode: args.retryError.statusCode,
      errorCode: args.retryError.errorCode,
      upstreamCode: args.retryError.upstreamCode,
      reason: args.retryError.reason
    });
    const retryBackoffMs = consumeProviderScopedRetryBackoffMs(providerScopedKey, {
      error: args.error,
      statusCode: args.retryError.statusCode
    });
    await waitRecoverableBackoffWithGlobalGate({
      key: providerScopedKey,
      ms: retryBackoffMs,
      signal: args.abortSignal,
      logNonBlockingError: args.logNonBlockingError
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'provider'
    };
  }
  if (actionPlan.backoff.scope !== 'recoverable') {
    const retryBackoffMs = await waitBeforeRetry(args.error, {
      attempt: args.attempt,
      signal: args.abortSignal
    });
    return {
      blockingRecoverable,
      retryBackoffMs,
      recoverableBackoffMs: 0,
      backoffScope: 'attempt'
    };
  }
  const recoverableKey = buildRecoverableErrorBackoffKey({
    providerKey: args.providerKey,
    runtimeKey: args.runtimeKey,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  const recoverableBackoffMs = consumeRecoverableErrorBackoffMs(recoverableKey, {
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason
  });
  try {
    await waitRecoverableBackoffWithGlobalGate({
      key: recoverableKey,
      ms: recoverableBackoffMs,
      signal: args.abortSignal,
      logNonBlockingError: args.logNonBlockingError
    });
  } catch (error) {
    const errRecord =
      error && typeof error === 'object' && !Array.isArray(error)
        ? (error as Record<string, unknown>)
        : undefined;
    const details =
      errRecord?.details && typeof errRecord.details === 'object' && !Array.isArray(errRecord.details)
        ? (errRecord.details as Record<string, unknown>)
        : undefined;
    if (
      errRecord
      && (errRecord.code === 'PROVIDER_TRAFFIC_SATURATED' || details?.reason === 'error_action_waiter_overload')
      && typeof args.stage === 'string'
    ) {
      errRecord.requestExecutorProviderErrorStage = args.stage;
      errRecord.details = {
        ...(details ?? {}),
        requestExecutorProviderErrorStage: args.stage
      };
    }
    throw error;
  }
  return {
    blockingRecoverable,
    retryBackoffMs: recoverableBackoffMs,
    recoverableBackoffMs,
    backoffScope: 'recoverable'
  };
}
