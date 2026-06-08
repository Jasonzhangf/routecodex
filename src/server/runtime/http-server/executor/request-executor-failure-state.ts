import type {
  BlockingRecoverableRouteHoldState,
  RequestLocalProviderRetryState
} from './request-executor-error-types.js';

export type RequestExecutorFailureState = {
  lastError: unknown;
  blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
  allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
  requestLocalProviderRetryState?: RequestLocalProviderRetryState;
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
    requestLocalProviderRetryState?: RequestLocalProviderRetryState;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    blockingRecoverableRouteHoldState: failure.blockingRecoverableRouteHoldState,
    allowBlockingRecoverableRetryBeyondAttemptBudget: failure.allowBlockingRecoverableRetryBeyondAttemptBudget,
    requestLocalProviderRetryState: failure.requestLocalProviderRetryState
  };
}

export function applySendFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    blockingRecoverableRouteHoldState: BlockingRecoverableRouteHoldState | null;
    allowBlockingRecoverableRetryBeyondAttemptBudget: boolean;
    requestLocalProviderRetryState?: RequestLocalProviderRetryState;
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
    requestLocalProviderRetryState: failure.requestLocalProviderRetryState,
    forcedRouteHint: failure.forcedRouteHint,
    contextOverflowRetries: failure.contextOverflowRetries,
    cumulativeExternalLatencyMs: failure.cumulativeExternalLatencyMs
  };
}
