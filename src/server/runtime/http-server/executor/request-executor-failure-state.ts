export type RequestExecutorFailureState = {
  lastError: unknown;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  cumulativeExternalLatencyMs: number;
  allowRetryBeyondAttemptBudget?: boolean;
};

export function applyResolveFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    allowRetryBeyondAttemptBudget?: boolean;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    allowRetryBeyondAttemptBudget: failure.allowRetryBeyondAttemptBudget === true,
  };
}

export function applySendFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    forcedRouteHint?: string;
    contextOverflowRetries: number;
    cumulativeExternalLatencyMs: number;
    allowRetryBeyondAttemptBudget?: boolean;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    forcedRouteHint: failure.forcedRouteHint,
    contextOverflowRetries: failure.contextOverflowRetries,
    cumulativeExternalLatencyMs: failure.cumulativeExternalLatencyMs,
    allowRetryBeyondAttemptBudget: failure.allowRetryBeyondAttemptBudget === true
  };
}
