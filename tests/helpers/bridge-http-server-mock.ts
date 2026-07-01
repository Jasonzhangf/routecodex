import { Readable } from 'node:stream';

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
    importCoreDist: async (subpath?: string) => {
      if (subpath === 'native/router-hotpath/native-hub-pipeline-resp-semantics') {
        return {
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
          projectResponsesClientBodyForClientWithNative: (payload: unknown) => payload,
        };
      }
      return {};
    },
    requireCoreDist: () => ({}),
    resolveImplForSubpath: () => null,
    resolveBaseDir: () => process.cwd(),
    getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
    getLlmsStatsSnapshot: () => null,
    extractSessionIdentifiersFromMetadata: () => ({}),
    extractContinuationContextSessionIdentifiersFromMetadata: () => ({}),
    loadRoutingInstructionStateSync: () => null,
    saveRoutingInstructionStateAsync: () => {},
    saveRoutingInstructionStateSync: () => {},
    sanitizeFollowupText: (value: string) => value,
    convertProviderResponse: async (value: unknown) => value,
    preloadCriticalBridgeRuntimeModules: async () => {},
    captureResponsesRequestContextForRequest: async () => {},
    recordResponsesResponseForRequest: async () => {},
    buildResponsesScopeContinuationExpiredErrorForHttp: () => ({
      error: {
        message: 'Responses continuation expired or not found for local scope materialization',
        type: 'invalid_request_error',
        code: 'responses_continuation_expired',
      },
    }),
    buildResponsesResumeClientErrorForHttp: (args: { status?: number; code?: string; origin?: string; message?: string }) => ({
      status: typeof args.status === 'number' ? args.status : 422,
      body: {
        error: {
          message: typeof args.message === 'string' ? args.message : 'Unable to resume Responses conversation',
          type: 'invalid_request_error',
          code: typeof args.code === 'string' ? args.code : 'responses_resume_failed',
          origin: typeof args.origin === 'string' ? args.origin : 'client',
        },
      },
    }),
    shouldProjectResponsesResumeClientErrorForHttp: (args: { origin?: string }) =>
      typeof args.origin === 'string' && args.origin.trim() === 'client',
    buildClientSseKeepaliveFrameForHttp: () => ': keepalive\\n\\n',
    buildResponsesMissingSseBridgeErrorPayloadForHttp: () => ({ error: { message: 'missing sse bridge' } }),
    buildResponsesPayloadFromChatForHttp: async (payload: unknown) => payload,
    buildResponsesRequestLogContextForHttp: () => ({}),
    buildResponsesSseErrorPayloadForHttp: () => ({ error: { message: 'sse error' } }),
    buildResponsesStructuredSseErrorPayloadForHttp: () => ({ error: { message: 'structured sse error' } }),
    createResponsesJsonToSseConverterForHttp: async () => ({
      convertResponseToJsonToSse: async () => ({})
    }),
    createChatJsonToSseConverterForHttp: async () => ({
      convertResponseToJsonToSse: async (payload: unknown, options?: Record<string, unknown>) => {
        const body =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : {};
        const requestId = typeof options?.requestId === 'string' ? options.requestId : 'req_test_chat_sse';
        return Readable.from([
          `data: ${JSON.stringify({
            id: body.id ?? requestId,
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model ?? 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: body.id ?? requestId,
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model ?? 'test-model',
            choices: Array.isArray(body.choices) ? body.choices : []
          })}\n\n`,
          'data: [DONE]\n\n'
        ]);
      }
    }),
    reprojectDirectChatToolCallStreamForHttp: async (args: { body: Record<string, unknown>; requestId?: string }) => {
      const requestId = typeof args.requestId === 'string' ? args.requestId : 'req_test_chat_sse';
      return Readable.from([
        `data: ${JSON.stringify({
          id: args.body.id ?? requestId,
          object: 'chat.completion.chunk',
          created: 1,
          model: args.body.model ?? 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        })}\n\n`,
        `data: ${JSON.stringify({
          id: args.body.id ?? requestId,
          object: 'chat.completion.chunk',
          created: 1,
          model: args.body.model ?? 'test-model',
          choices: Array.isArray(args.body.choices) ? args.body.choices : []
        })}\n\n`,
        'data: [DONE]\n\n'
      ]);
    },
    importResponsesHandlerCoreDist: async () => ({}),
    isToolCallContinuationResponseForHttp: () => false,
    normalizeChatUsagePayloadForHttp: (payload: unknown) => payload,
    normalizeResponsesClientPayloadForHttp: (payload: unknown) => payload,
    normalizeResponsesJsonBodyForHttp: (payload: unknown) => payload,
    planResponsesContinuationCloseActionForHttp: () => ({ action: 'none' }),
    prepareResponsesJsonBodyForSseBridgeForHttp: (payload: unknown) => payload,
    prepareResponsesJsonClientDispatchPlanForHttp: () => ({ mode: 'json' }),
    prepareResponsesJsonSseDispatchPlanForHttp: () => ({ mode: 'sse' }),
    projectResponsesClientPayloadForClientForHttp: (payload: unknown) => payload,
    requireResponsesHandlerCoreDist: () => ({}),
    resolveRelayResponsesClientSseStreamForHttp: () => undefined,
    resolveResponsesClientPayloadFinishReasonForHttp: () => undefined,
    resolveResponsesRequestContextForHttp: () => ({}),
    shouldDispatchResponsesSseToClientForHttp: () => false,
    shouldReprojectRelayResponsesSseForHttp: () => false,
    resumeResponsesConversation: async () => ({ payload: {}, meta: {} }),
    resumeLatestResponsesContinuationByScope: async () => null,
    materializeLatestResponsesContinuationByScope: async () => null,
    rebindResponsesConversationRequestId: async () => {},
    clearResponsesConversationByRequestId: async () => {},
    clearResponsesConversationOnHandlerFailureForHttp: async () => {},
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
