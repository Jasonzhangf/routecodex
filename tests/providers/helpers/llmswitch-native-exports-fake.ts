type AnyRecord = Record<string, unknown>;

function planResponsesRequestBodyForHttpFake(payload: unknown): {
  requestBodyMetadata?: AnyRecord;
  pipelineBody: AnyRecord;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { pipelineBody: {} };
  }
  const pipelineBody = { ...(payload as AnyRecord) };
  const metadata = pipelineBody.metadata;
  delete pipelineBody.metadata;
  return {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { requestBodyMetadata: metadata as AnyRecord }
      : {}),
    pipelineBody,
  };
}

export function buildLlmswitchNativeExportsFake(overrides: AnyRecord = {}): AnyRecord {
  const fake: AnyRecord = {
    buildAnthropicResponseFromChatJson: async (payload: unknown) => payload,
    buildChatResponseFromResponsesNative: (payload: unknown) => payload,
    buildResponsesPayloadFromChatNative: (payload: unknown) => payload,
    buildResponsesRequestFromChatNative: (payload: unknown) => payload,
    buildRequestStageRuntimeControlWritePlanNative: () => ({}),
    captureReqInboundResponsesContextSnapshot: async () => ({}),
    captureReqInboundResponsesContextSnapshotJson: () => ({}),
    classifyEmptyResponseSignalNative: () => ({ kind: 'none' }),
    classifyProviderFailure: () => ({ code: 'UNKNOWN', retryable: false }),
    convertResponsesRequestToChatNative: (payload: AnyRecord) => ({
      request: { model: payload.model, messages: [], tools: payload.tools }
    }),
    deriveFinishReasonNative: () => undefined,
    describeHubPipelineContractsNative: () => ({}),
    describeHubPipelineContractsWithNative: () => ({}),
    describeMetaCarrierContractsNative: () => ({}),
    describeMetaCarrierContractsWithNative: () => ({}),
    describePipelineContractNative: () => ({}),
    describePipelineContractWithNative: () => ({}),
    describeServerContractsWithNative: () => ({}),
    describeServerModuleHelpWithNative: () => ({}),
    describeVirtualRouterContractsNative: () => ({}),
    describeVirtualRouterContractsWithNative: () => ({}),
    detectRetryableEmptyAssistantResponseNative: () => false,
    detectToolExecutionFailuresNative: () => [],
    evaluateResponsesDirectRouteDecisionNative: () => ({}),
    evaluateSingletonRoutePoolExhaustionNative: () => ({}),
    extractSessionIdentifiersFromMetadataNative: (metadata: AnyRecord = {}) => ({
      sessionId: metadata.sessionId ?? metadata.session_id,
      conversationId: metadata.conversationId ?? metadata.conversation_id,
    }),
    extractServertoolCliResultRouteHintFromRequestNative: () => undefined,
    getNetworkErrorCodes: () => [],
    getRouterHotpathJsonBindingSync: () => ({}),
    hasDeclaredApplyPatchToolNative: () => false,
    hasRequestedToolsInSemanticsNative: () => false,
    injectMcpToolsForChatJson: async (payload: unknown) => payload,
    injectMcpToolsForResponsesJson: async (payload: unknown) => payload,
    isEmptyClientResponsePayloadNative: () => false,
    isProviderNativeResumeContinuationNative: () => false,
    isRequiredToolCallTurnNative: () => false,
    isToolCallContinuationResponseNative: () => false,
    isToolResultFollowupTurnNative: () => false,
    mapChatToolsToBridgeJson: async () => [],
    materializeProviderOwnedSubmitContext: async () => ({}),
    mergeObservedRoutePoolChainNative: () => ({}),
    normalizeAssistantTextToToolCallsJson: async () => ({}),
    normalizeExplicitRoutePoolNative: () => ({}),
    normalizeResponsesDirectCurrentRequestPayload: (payload: AnyRecord) => ({ changed: false, payload }),
    planPrimaryExhaustedToDefaultPoolNative: () => ({}),
    planResponsesRequestBodyForHttpNative: planResponsesRequestBodyForHttpFake,
    planResponsesContinuationRequestAction: async () => ({}),
    planResponsesHandlerEntry: async () => ({}),
    planResponsesJsonClientDispatchNative: () => ({}),
    planResponsesRequestContext: async () => ({}),
    shouldManageResponsesConversationForHttpNative: (entryEndpoint?: string) =>
      entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs',
    buildResponsesScopeContinuationExpiredErrorForHttpNative: () => ({
      error: {
        message: 'Responses continuation expired or not found for local scope materialization',
        type: 'invalid_request_error',
        code: 'responses_continuation_expired',
      },
    }),
    buildResponsesResumeClientErrorForHttpNative: (args: {
      status?: number;
      code?: string;
      origin?: string;
      message?: string;
    } = {}) => ({
      status: typeof args.status === 'number' ? args.status : 422,
      body: {
        error: {
          message:
            typeof args.message === 'string' && args.message.trim()
              ? args.message
              : 'Unable to resume Responses conversation',
          type: 'invalid_request_error',
          code:
            typeof args.code === 'string' && args.code.trim()
              ? args.code
              : 'responses_resume_failed',
          origin:
            typeof args.origin === 'string' && args.origin.trim()
              ? args.origin
              : 'client',
        },
      },
    }),
    shouldProjectResponsesResumeClientErrorForHttpNative: (origin?: string) =>
      typeof origin === 'string' && origin.trim() === 'client',
    projectResponsesClientPayloadForClientNative: () => ({}),
    projectResponsesSseFrameForClientNative: () => '',
    projectSseErrorEventPayloadNative: () => ({}),
    resolveEntryProtocolFromEndpointNative: () => 'openai-responses',
    resolveErrorErr05RouteAvailabilityDecisionNative: () => ({}),
    resolveProviderResponseRequestSemanticsNative: () => undefined,
    resolveProviderRetryExecutionPolicyNative: () => ({}),
    sanitizeProviderOutboundPayload: async (input: { payload: AnyRecord }) => input.payload,
    shouldRecordSnapshotsNative: () => false,
    stripResponsesStoredContextInputMediaNative: (payload: unknown) => payload,
    updateResponsesContractProbeFromSseChunkNative: () => ({}),
    updateResponsesSseTransportTerminalStateNative: (input: unknown) => input,
    validateApplyPatchArgumentsNative: () => ({ ok: true }),
    validateCanonicalClientToolCall: () => ({ ok: true }),
    validatePipelineNodeContractBoundaryNative: () => ({ ok: true }),
    writeSnapshotViaHooksNative: () => undefined,
  };
  return { ...fake, ...overrides };
}
