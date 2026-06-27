import {
  consumeLogicalChainRecoverableRetry,
  deriveLogicalRequestChainKey,
  releaseLogicalRequestChain,
  resetRequestExecutorRetryStateForTests,
  retainLogicalRequestChain,
} from './request-executor-retry-state.js';
import {
  resolveProviderRetryExclusionPlan
} from './request-executor-retry-decision.js';
import {
  buildProviderRetryTelemetryPlan,
  emitRequestExecutorProviderRetryTelemetry
} from './request-executor-retry-telemetry.js';
import {
  resolveProviderRetryExecutionPlan
} from './request-executor-retry-execution-plan.js';
import type {
  RetryErrorSnapshot
} from './request-executor-error-types.js';

export {
  buildProviderRetryTelemetryPlan,
  consumeLogicalChainRecoverableRetry,
  deriveLogicalRequestChainKey,
  emitRequestExecutorProviderRetryTelemetry,
  releaseLogicalRequestChain,
  resolveProviderRetryExecutionPlan,
  resolveProviderRetryExclusionPlan,
  retainLogicalRequestChain
};

export function resetRequestExecutorRetryPlannerState(): void {
  resetRequestExecutorRetryStateForTests();
}
