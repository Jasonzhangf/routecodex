import {
  buildRecoverableErrorBackoffKey,
  clearRecoverableErrorBackoff,
  consumeLogicalChainRecoverableRetry,
  consumeProviderScopedRetryBackoffMs,
  consumeRecoverableErrorBackoffMs,
  deriveLogicalRequestChainKey,
  releaseLogicalRequestChain,
  resetRequestExecutorRetryStateForTests,
  retainLogicalRequestChain,
} from './request-executor-retry-state.js';
import {
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExclusionPlan
} from './request-executor-retry-decision.js';
import {
  buildProviderRetryTelemetryPlan,
  emitRequestExecutorProviderRetryTelemetry
} from './request-executor-retry-telemetry.js';
import {
  resolveProviderRetryExecutionPlan
} from './request-executor-retry-execution-plan.js';
import {
  resolveExcludedProviderReselectionPlan
} from './request-executor-reselection-plan.js';
import type {
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export {
  buildProviderRetryTelemetryPlan,
  buildRecoverableErrorBackoffKey,
  clearRecoverableErrorBackoff,
  consumeLogicalChainRecoverableRetry,
  consumeProviderScopedRetryBackoffMs,
  consumeRecoverableErrorBackoffMs,
  deriveLogicalRequestChainKey,
  emitRequestExecutorProviderRetryTelemetry,
  releaseLogicalRequestChain,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExecutionPlan,
  resolveProviderRetryExclusionPlan,
  retainLogicalRequestChain
};

export function resetRequestExecutorRetryPlannerState(): void {
  resetRequestExecutorRetryStateForTests();
}
