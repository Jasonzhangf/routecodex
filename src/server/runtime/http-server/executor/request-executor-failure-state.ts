import type {
  BlockingRecoverableRouteHoldState
} from './request-executor-error-types.js';

export type RequestExecutorFailureState = {
  lastError: unknown;
  blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
  allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  cumulativeExternalLatencyMs: number;
};

export function applyResolveFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
    allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    blockingRecoverableRouteHoldState: failure.blockingRecoverableRouteHoldState,
    allowBlockingRecoverableRetryBeyondAttemptBudget: failure.allowBlockingRecoverableRetryBeyondAttemptBudget
  };
}

export function applySendFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
    allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
    forcedRouteHint?: string;
    contextOverflowRetries: number;
    cumulativeExternalLatencyMs: number;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    blockingRecoverableRouteHoldState: failure.blockingRecoverableRouteHoldState,
    allowBlockingRecoverableRetryBeyondAttemptBudget: failure.allowBlockingRecoverableRetryBeyondAttemptBudget,
    forcedRouteHint: failure.forcedRouteHint,
    contextOverflowRetries: failure.contextOverflowRetries,
    cumulativeExternalLatencyMs: failure.cumulativeExternalLatencyMs
  };
}
