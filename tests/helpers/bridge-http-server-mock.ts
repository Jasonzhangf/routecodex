type BridgeMock = Record<string, unknown>;

function deriveFinishReasonFromMockBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? (record.choices as Array<Record<string, unknown>>) : [];
  const firstChoice = choices[0];
  if (firstChoice && typeof firstChoice.finish_reason === 'string' && firstChoice.finish_reason.trim()) {
    return firstChoice.finish_reason.trim();
  }
  if (typeof record.stop_reason === 'string' && record.stop_reason.trim()) {
    return record.stop_reason.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  if (output.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call')) {
    return 'tool_calls';
  }
  if (record.status === 'requires_action') {
    return 'tool_calls';
  }
  if (record.status === 'completed') {
    return 'stop';
  }
  const message = firstChoice && typeof firstChoice.message === 'object' && firstChoice.message
    ? (firstChoice.message as Record<string, unknown>)
    : undefined;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return 'tool_calls';
  }
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) {
    return 'stop';
  }
  return undefined;
}

export function createBridgeHttpServerMock(overrides: BridgeMock = {}): BridgeMock {
  return {
    importCoreDist: async () => ({}),
    requireCoreDist: () => ({}),
    resolveImplForSubpath: () => null,
    resolveBaseDir: () => process.cwd(),
    getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
    getLlmsStatsSnapshot: () => null,
    syncStoplessGoalStateFromRequest: () => {},
    persistStoplessGoalStateSnapshot: async () => {},
    readStoplessGoalState: () => null,
    extractSessionIdentifiersFromMetadata: () => ({}),
    loadRoutingInstructionStateSync: () => null,
    saveRoutingInstructionStateAsync: () => {},
    saveRoutingInstructionStateSync: () => {},
    sanitizeFollowupText: (value: string) => value,
    convertProviderResponse: async (value: unknown) => value,
    preloadCriticalBridgeRuntimeModules: async () => {},
    captureResponsesRequestContextForRequest: async () => {},
    recordResponsesResponseForRequest: async () => {},
    resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
    resumeLatestResponsesContinuationByScope: async () => null,
    materializeLatestResponsesContinuationByScope: async () => null,
    rebindResponsesConversationRequestId: async () => {},
    clearResponsesConversationByRequestId: async () => {},
    finalizeResponsesConversationRequestRetention: async () => {},
    clearAllResponsesConversationState: async () => {},
    resetResponsesConversationStateForRestartSimulation: async () => {},
    clearUnresolvedResponsesConversationRequests: async () => {},
    writeSnapshotViaHooks: async () => {},
    createSnapshotRecorder: () => ({}) as any,
    deriveFinishReasonNative: deriveFinishReasonFromMockBody,
    mapChatToolsToBridgeJson: async () => [],
    planResponsesHandlerEntry: async () => ({ mode: 'passthrough' }),
    normalizeAssistantTextToToolCallsJson: async () => ({ toolCalls: [] }),
    buildAnthropicResponseFromChatJson: async (payload: unknown) => payload,
    injectMcpToolsForChatJson: async (payload: unknown) => payload,
    injectMcpToolsForResponsesJson: async (payload: unknown) => payload,
    sanitizeProviderOutboundPayload: async (payload: unknown) => payload,
    evaluateResponsesDirectRouteDecisionNative: async () => ({ mode: 'passthrough' }),
    hasDeclaredApplyPatchToolNative: () => false,
    isToolCallContinuationResponseNative: () => false,
    updateResponsesContractProbeFromSseChunkNative: () => ({}),
    buildResponsesTerminalSseFramesFromProbeNative: () => [],
    createResponsesSseToJsonConverter: async () => ({
      convertSseToJson: async () => ({})
    }),
    createResponsesJsonToSseConverter: async () => ({
      convertResponseToJsonToSse: async () => ({})
    }),
    reportProviderErrorToRouterPolicy: async (event: unknown) => event,
    reportProviderSuccessToRouterPolicy: async (event: unknown) => event,
    classifyProviderFailure: () => ({
      category: 'unknown',
      recoverable: false,
      affectsHealth: false,
      shouldRetry: false
    }),
    getNetworkErrorCodes: () => [],
    bootstrapVirtualRouterConfig: async (input: unknown) => ({ config: input, targetRuntime: {} }),
    getHubPipelineCtor: async () =>
      class HubPipelineMock {
        updateVirtualRouterConfig(): void {}
        async execute(): Promise<any> {
          return { metadata: {} };
        }
      },
    getHubPipelineCtorForImpl: async () =>
      class HubPipelineMock {
        updateVirtualRouterConfig(): void {}
        async execute(): Promise<any> {
          return { metadata: {} };
        }
      },
    ...overrides
  };
}
