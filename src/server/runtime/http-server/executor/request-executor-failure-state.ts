export type RequestExecutorFailureState = {
  lastError: unknown;
  forcedRouteHint?: string;
  contextOverflowRetries: number;
  cumulativeExternalLatencyMs: number;
};

export function applyResolveFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
  };
}

export function applySendFailureState(
  state: RequestExecutorFailureState,
  failure: {
    lastError: unknown;
    forcedRouteHint?: string;
    contextOverflowRetries: number;
    cumulativeExternalLatencyMs: number;
  }
): RequestExecutorFailureState {
  return {
    ...state,
    lastError: failure.lastError,
    forcedRouteHint: failure.forcedRouteHint,
    contextOverflowRetries: failure.contextOverflowRetries,
    cumulativeExternalLatencyMs: failure.cumulativeExternalLatencyMs
  };
}
