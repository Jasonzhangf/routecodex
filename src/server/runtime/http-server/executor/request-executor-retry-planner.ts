import {
  computeProviderFailureBackoffDelayMs
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  acquireRecoverableRetryWaiterSlotForTests,
  buildProviderTransportBackoffKey,
  buildRecoverableErrorBackoffKey,
  clearProviderTransportBackoff,
  consumeLogicalChainRecoverableRetry,
  consumeProviderScopedRetryBackoffMs,
  consumeProviderTransportBackoffMs,
  consumeRecoverableErrorBackoffMs,
  deriveLogicalRequestChainKey,
  peekProviderTransportBackoffConsecutiveForTests,
  peekProviderTransportBackoffWaitMs,
  peekRecoverableRetryWaitersForTests,
  releaseLogicalRequestChain,
  releaseRecoverableRetryWaiterSlotForTests,
  resetRequestExecutorRetryStateForTests,
  retainLogicalRequestChain,
  waitProviderTransportBackoffWithGate,
  waitRecoverableBackoffWithGlobalGate
} from './request-executor-retry-state.js';
import {
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
  acquireRecoverableRetryWaiterSlotForTests,
  buildProviderRetryTelemetryPlan,
  buildProviderTransportBackoffKey,
  buildRecoverableErrorBackoffKey,
  clearProviderTransportBackoff,
  consumeLogicalChainRecoverableRetry,
  consumeProviderScopedRetryBackoffMs,
  consumeProviderTransportBackoffMs,
  consumeRecoverableErrorBackoffMs,
  deriveLogicalRequestChainKey,
  emitRequestExecutorProviderRetryTelemetry,
  isLastAvailableProvider429,
  peekProviderTransportBackoffConsecutiveForTests,
  peekProviderTransportBackoffWaitMs,
  peekRecoverableRetryWaitersForTests,
  releaseLogicalRequestChain,
  releaseRecoverableRetryWaiterSlotForTests,
  resolveExcludedProviderReselectionPlan,
  resolveProviderRetryEligibilityPlan,
  resolveProviderRetryExecutionPlan,
  resolveProviderRetryExclusionPlan,
  retainLogicalRequestChain,
  waitProviderTransportBackoffWithGate,
  waitRecoverableBackoffWithGlobalGate
};

export function resetRequestExecutorRetryPlannerState(): void {
  resetRequestExecutorRetryStateForTests();
  resetSessionStormBackoffStateForTests();
}

export {
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
