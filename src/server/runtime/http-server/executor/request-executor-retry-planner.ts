import {
  computeProviderFailureBackoffDelayMs
} from '../../../../providers/core/runtime/provider-failure-policy.js';
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
  buildSessionStormHardBlockError,
  clearSessionStormBackoff,
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffConsecutiveForTests,
  peekSessionStormBackoffWaitMs,
  peekSessionStormBackoffWaitMsForTests,
  resetSessionStormBackoffStateForTests,
  resolveSessionStormBackoffBaseMs,
  resolveSessionStormBackoffBaseMsForError,
  resolveSessionStormBackoffMaxMs,
  resolveSessionStormBackoffMaxMsForError,
  resolveSessionStormBackoffScope,
  resolveSessionStormBackoffScopes,
  sessionStormBackoffGateState,
  waitSessionStormBackoffWithGate
} from './request-executor-session-storm-backoff.js';
import {
  isLastAvailableProvider429,
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
  isLastAvailableProvider429,
  releaseLogicalRequestChain,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExecutionPlan,
  resolveProviderRetryExclusionPlan,
  retainLogicalRequestChain
};

export function resetRequestExecutorRetryPlannerState(): void {
  resetRequestExecutorRetryStateForTests();
  resetSessionStormBackoffStateForTests();
}

export {
  buildSessionStormHardBlockError,
  clearSessionStormBackoff,
  consumeSessionStormBackoffMs,
  isSessionStormBackoffCandidate,
  peekSessionStormBackoffConsecutiveForTests,
  peekSessionStormBackoffWaitMs,
  peekSessionStormBackoffWaitMsForTests,
  resolveSessionStormBackoffBaseMs,
  resolveSessionStormBackoffBaseMsForError,
  resolveSessionStormBackoffMaxMs,
  resolveSessionStormBackoffMaxMsForError,
  resolveSessionStormBackoffScope,
  resolveSessionStormBackoffScopes,
  sessionStormBackoffGateState,
  waitSessionStormBackoffWithGate
};
