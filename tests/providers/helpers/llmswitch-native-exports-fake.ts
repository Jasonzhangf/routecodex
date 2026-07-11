type AnyRecord = Record<string, unknown>;

function readTrimmedString(row: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function buildResponsesResumeControlForContinuationContextForHttpFake(
  resumeMeta: AnyRecord = {}
): AnyRecord {
  const out: AnyRecord = {};
  const copyString = (key: string): void => {
    const value = resumeMeta[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  };
  const copyBoolean = (key: string): void => {
    if (typeof resumeMeta[key] === 'boolean') {
      out[key] = resumeMeta[key];
    }
  };
  const copyNumber = (key: string): void => {
    if (typeof resumeMeta[key] === 'number' && Number.isFinite(resumeMeta[key])) {
      out[key] = resumeMeta[key];
    }
  };

  for (const key of [
    'responseId',
    'restoredFromResponseId',
    'previousRequestId',
    'requestId',
    'scopeKey',
    'entryKind',
    'continuationOwner',
    'materializedMode',
  ]) {
    copyString(key);
  }
  if (out.continuationOwner === 'direct') {
    copyString('providerKey');
  }
  for (const key of ['restored', 'materialized']) {
    copyBoolean(key);
  }
  for (const key of [
    'deltaInputItems',
    'toolOutputs',
    'incomingInputItems',
    'continuationDeltaItems',
    'fullInputItems',
  ]) {
    copyNumber(key);
  }
  const rawToolOutputs = resumeMeta.toolOutputsDetailed;
  if (Array.isArray(rawToolOutputs)) {
    const toolOutputsDetailed = rawToolOutputs.flatMap((item): AnyRecord[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return [];
      }
      const row = item as AnyRecord;
      const callId = readTrimmedString(row, ['callId', 'originalId', 'call_id', 'tool_call_id', 'id']);
      const outputText = readTrimmedString(row, ['outputText', 'output_text', 'output']);
      if (!callId || !outputText) {
        return [];
      }
      const originalId = readTrimmedString(row, ['originalId', 'original_id']);
      return [{
        callId,
        ...(originalId ? { originalId } : {}),
        outputText,
      }];
    });
    if (toolOutputsDetailed.length > 0) {
      out.toolOutputsDetailed = toolOutputsDetailed;
    }
  }

  return out;
}

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

export function finalizeResponsesHandlerPayloadForHttpFake(args: {
  payload?: AnyRecord;
  isSubmitToolOutputs?: boolean;
  outboundStream?: boolean;
}): AnyRecord {
  const payload = { ...(args.payload ?? {}) };
  if (args.isSubmitToolOutputs !== true && args.outboundStream === true && payload.stream !== true) {
    payload.stream = true;
  }
  return payload;
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
    describeMetaCarrierContractsNative: () => ({}),
    describePipelineContractNative: () => ({}),
    describeVirtualRouterContractsNative: () => ({}),
    detectRetryableEmptyAssistantResponseNative: () => false,
    detectToolExecutionFailuresNative: () => [],
    classifyRuntimeErrorSignalNative: () => null,
    shouldLogClientToolErrorToConsoleNative: () => false,
    shouldLogRuntimeErrorSignalToConsoleNative: () => false,
    shouldWriteClientToolErrorsampleNative: () => true,
    resetSnapshotRecorderErrorsampleStateNative: () => undefined,
    appendSnapshotStageTraceNative: ({ trace }: { trace?: unknown[] }) => trace ?? [],
    summarizeSnapshotStageTraceNative: (trace: unknown[]) => trace,
    shouldInspectRuntimeErrorFastNative: () => false,
    shouldInspectToolFailuresNative: () => false,
    resolveRequestTailSummaryNative: () => null,
    summarizeClientToolObservationNative: () => ({
      topLevelKeys: [],
      failureCount: 0,
      toolMessageCount: 0,
      failures: [],
      toolMessages: [],
    }),
    evaluateResponsesDirectRouteDecisionNative: () => ({}),
    evaluateSingletonRoutePoolExhaustionNative: () => ({}),
    extractSessionIdentifiersFromMetadataNative: (metadata: AnyRecord = {}) => ({
      sessionId: metadata.sessionId ?? metadata.session_id,
      conversationId: metadata.conversationId ?? metadata.conversation_id,
    }),
    extractServertoolCliResultRouteHintFromRequestNative: () => undefined,
    getRouterHotpathJsonBindingSync: () => ({}),
    hasDeclaredApplyPatchToolNative: () => false,
    hasRequestedToolsInSemanticsNative: () => false,
    injectMcpToolsForChatJson: async (payload: unknown) => payload,
    injectMcpToolsForResponsesJson: async (payload: unknown) => payload,
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
    buildResponsesResumeControlForContinuationContextForHttpNative:
      buildResponsesResumeControlForContinuationContextForHttpFake,
    finalizeResponsesHandlerPayloadForHttpNative: finalizeResponsesHandlerPayloadForHttpFake,
    planResponsesHandlerStreamForHttpNative: (args: {
      payload?: AnyRecord;
      forceStream?: boolean;
      acceptsSse: boolean;
      requestTimeoutMs?: number;
    }) => {
      const payload = args.payload ?? {};
      const hasExplicitStream = typeof payload.stream === 'boolean';
      const originalStream = payload.stream === true;
      const outboundStream = typeof args.forceStream === 'boolean'
        ? args.forceStream
        : (hasExplicitStream ? originalStream : args.acceptsSse);
      return {
        originalStream,
        outboundStream,
        inboundStream: outboundStream,
        acceptsSse: args.acceptsSse,
        requestStartMeta: {
          inboundStream: outboundStream,
          outboundStream,
          clientAcceptsSse: args.acceptsSse,
          originalStream,
          type: payload.type,
          timeoutMs: args.requestTimeoutMs,
        },
      };
    },
    planResponsesContinuationRequestAction: async () => ({}),
    planResponsesHandlerEntry: async () => ({}),
    planResponsesJsonClientDispatchNative: () => ({}),
    planResponsesRequestContext: async () => ({}),
    shouldManageResponsesConversationForHttpNative: (entryEndpoint?: string) =>
      entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs',
    buildResponsesConversationPortScopeForHttpNative: (portContext?: {
      matchedPort?: unknown;
      localPort?: unknown;
      routingPolicyGroup?: unknown;
    } | null) => {
      const matchedPort = typeof portContext?.matchedPort === 'number'
        ? portContext.matchedPort
        : typeof portContext?.localPort === 'number'
          ? portContext.localPort
          : undefined;
      const routingPolicyGroup = typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()
        ? portContext.routingPolicyGroup.trim()
        : undefined;
      return {
        ...(typeof matchedPort === 'number' ? { matchedPort } : {}),
        ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
      };
    },
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
    validateCanonicalClientToolCall: () => ({ ok: true }),
    writeSnapshotViaHooksNative: () => undefined,
  };
  return { ...fake, ...overrides };
}
