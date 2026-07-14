import { isHostRequestExecutorErrorStage } from './request-executor-provider-failure.js';
import { isProviderProtocolBoundaryError } from './request-executor-error-shared.js';
import { buildErrorErr02HostCapturedInput } from '../../../../providers/core/runtime/provider-failure-policy.js';
import { resolveErrorErr05ExecutionDecisionNative } from '../../../../modules/llmswitch/bridge/error-execution-decision-host.js';
import type {
  ProviderRetryExecutionPlan,
  RequestExecutorProviderErrorStage,
  RetryErrorSnapshot,
} from './request-executor-error-types.js';

export const ERROR_EXECUTION_DECISION_CONSUMER_FEATURE_ID = 'feature_id: error.execution_decision_consumer';

export type RequestExecutorErrorErr04RouterPolicyEnvelope = {
  // topology-node: ErrorErr04RouterPolicyApplied (executor-side envelope alias)
  retryExecutionPlan: ProviderRetryExecutionPlan;
};

export type ErrorErr05ExecutionDecision = ProviderRetryExecutionPlan;

type RuntimeManager = {
  resolveRuntimeKey(providerKey?: string, metadata?: Record<string, unknown>): string | undefined;
};

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

/**
 * Thin ErrorErr05 host executor.
 *
 * Rust owns classification consumption, route exclusion, retry/reroute,
 * default-pool exhaustion, verified-last-provider, and client projection gate.
 * TS performs only request-local set mutation and attempt accounting effects.
 */
export async function resolveProviderRetryExecutionPlan(args: {
  error: unknown;
  retryError: RetryErrorSnapshot;
  attempt: number;
  maxAttempts: number;
  stage?: RequestExecutorProviderErrorStage;
  providerKey?: string;
  runtimeKey?: string;
  logicalRequestChainKey: string;
  logicalChainRetryLimitStageRequestId: string;
  routePool?: string[];
  routePoolIsAuthoritative?: boolean;
  runtimeManager?: RuntimeManager;
  excludedProviderKeys: Set<string>;
  recordAttempt: (args: { error: boolean }) => void;
  logStage: (stage: string, requestId: string, details?: Record<string, unknown>) => void;
  promptTooLong?: boolean;
  contextOverflowRetries?: number;
  maxContextOverflowRetries?: number;
  status?: number;
  forceExcludeCurrentProviderOnRetry?: boolean;
  isStreamingRequest?: boolean;
  providerOwnedContinuation?: boolean;
  abortSignal?: AbortSignal;
  defaultTierAvailable?: boolean;
  defaultPoolSingletonProvider?: boolean;
  logNonBlockingError: LogNonBlockingError;
}): Promise<ProviderRetryExecutionPlan> {
  const errorErr02HostCaptured = buildErrorErr02HostCapturedInput({
    error: args.error,
    stage: args.stage,
    statusCode: args.retryError.statusCode,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    reason: args.retryError.reason,
  });
  const hostContractStage = isHostRequestExecutorErrorStage(args.stage ?? 'provider.send');
  const hostContractFailure = hostContractStage
    && args.retryError.errorCode !== 'EMPTY_ASSISTANT_RESPONSE'
    && args.retryError.errorCode !== 'MISSING_REQUIRED_TOOL_CALL';

  args.recordAttempt({ error: true });
  const decision = resolveErrorErr05ExecutionDecisionNative({
    errorErr02HostCaptured,
    stage: args.stage,
    errorCode: args.retryError.errorCode,
    upstreamCode: args.retryError.upstreamCode,
    providerKey: args.providerKey,
    routePool: args.routePool ?? [],
    excludedProviderKeys: Array.from(args.excludedProviderKeys),
    routePoolIsAuthoritative: args.routePoolIsAuthoritative === true,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    defaultPoolAvailable: args.defaultTierAvailable === true,
    defaultPoolSingletonProvider: args.defaultPoolSingletonProvider === true,
    promptTooLong: args.promptTooLong === true,
    providerOwnedContinuation: args.providerOwnedContinuation === true,
    protocolBoundaryFailure: isProviderProtocolBoundaryError(args.error, args.retryError),
    hostContractFailure,
    forceExcludeCurrentProviderOnRetry: args.forceExcludeCurrentProviderOnRetry === true,
    isStreamingRequest: args.isStreamingRequest === true,
  });

  args.excludedProviderKeys.clear();
  for (const providerKey of decision.excludedProviderKeys) {
    args.excludedProviderKeys.add(providerKey);
  }
  const { excludedProviderKeys: _effectApplied, ...plan } = decision;
  return plan;
}
