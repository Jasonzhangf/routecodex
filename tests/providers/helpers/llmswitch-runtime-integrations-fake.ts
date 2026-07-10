type AnyRecord = Record<string, unknown>;

export function buildLlmswitchRuntimeIntegrationsFake(overrides: AnyRecord = {}): AnyRecord {
  const fake: AnyRecord = {
    buildResponsesJsonFromSseStreamWithNative: async () => ({ status: 'completed', output: [] }),
    captureResponsesRequestContextForRequest: async () => undefined,
    clearAllResponsesConversationState: async () => undefined,
    clearResponsesConversationByRequestId: async () => undefined,
    clearUnresolvedResponsesConversationRequests: async () => 0,
    finalizeResponsesConversationRequestRetention: async () => undefined,
    lookupResponsesContinuationByResponseId: async () => null,
    materializeLatestResponsesContinuationByScope: async () => null,
    preloadCriticalBridgeRuntimeModules: async () => ({ loaded: [] }),
    rebindResponsesConversationRequestId: async () => undefined,
    recordResponsesResponseForRequest: async () => undefined,
    reportProviderErrorToRouterPolicy: async () => undefined,
    reportProviderSuccessToRouterPolicy: async () => undefined,
    resetResponsesConversationStateForRestartSimulation: async () => undefined,
    resumeLatestResponsesContinuationByScope: async () => null,
    resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
    writeSnapshotViaHooks: async () => undefined,
  };
  return { ...fake, ...overrides };
}
