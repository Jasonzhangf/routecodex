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
  consumeRecoverableErrorBackoffMs
} from './request-executor-retry-state.js';

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
  return {
    blockingRecoverable,
    retryBackoffMs: 0,
    recoverableBackoffMs: 0,
    backoffScope: 'none'
  };
}
