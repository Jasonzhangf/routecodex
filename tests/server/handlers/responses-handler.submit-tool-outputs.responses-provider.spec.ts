import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import {
  buildResponsesResumeControlForContinuationContextForHttpFake,
} from '../../providers/helpers/llmswitch-native-exports-fake.js';

const mockResumeResponsesConversation = jest.fn();
const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();
const mockClearResponsesConversationByRequestId = jest.fn(async () => undefined);
const mockFinalizeResponsesConversationRequestRetention = jest.fn(async () => undefined);
const mockMaterializeLatestResponsesContinuationByScope = jest.fn(async () => null);
const mockResumeLatestResponsesContinuationByScope = jest.fn(async () => null);
const mockRecordResponsesResponseForRequest = jest.fn(async () => undefined);

const planResponsesRequestBodyForHttpMock = (payload: Record<string, unknown>) => {
  const pipelineBody = { ...(payload ?? {}) };
  const metadata = pipelineBody.metadata;
  delete pipelineBody.metadata;
  return {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { requestBodyMetadata: metadata as Record<string, unknown> }
      : {}),
    pipelineBody,
  };
};

const createNativeExportsMock = () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({
    resolveSessionColorStr: jest.fn(() => JSON.stringify('')),
    resolveSessionLogColorKeyJson: jest.fn(() => JSON.stringify('')),
  })),
  getNetworkErrorCodes: jest.fn(() => []),
  mapChatToolsToBridgeJson: jest.fn(async (rawTools: unknown) => Array.isArray(rawTools) ? rawTools : []),
  injectMcpToolsForChatJson: jest.fn(async (input: unknown) => input),
  injectMcpToolsForResponsesJson: jest.fn(async (input: unknown) => input),
  normalizeAssistantTextToToolCallsJson: jest.fn(async (input: unknown) => input),
  captureReqInboundResponsesContextSnapshotJson: jest.fn((args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  captureReqInboundResponsesContextSnapshot: jest.fn(async (args: { rawRequest?: Record<string, unknown> }) => ({
    input: Array.isArray(args.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args.rawRequest?.tools) ? args.rawRequest.tools : [],
  })),
  planResponsesHandlerEntry: jest.fn(async (payload: Record<string, unknown>, entryEndpoint: string, responseIdFromPath?: string) => ({
    mode: entryEndpoint === '/v1/responses.submit_tool_outputs' ? 'submit_tool_outputs' : 'none',
    payload: {
      ...payload,
      ...(responseIdFromPath ? { response_id: responseIdFromPath } : {}),
    },
    responseId: responseIdFromPath,
  })),
  materializeProviderOwnedSubmitContext: jest.fn(async (input: { payload?: Record<string, unknown> }) => {
    const payload = input.payload ?? {};
    const toolOutputs = Array.isArray(payload.tool_outputs) ? payload.tool_outputs : [];
    const materializedInput = toolOutputs.map((item) => {
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
      return {
        type: 'function_call_output',
        call_id: record.call_id,
        output: record.output,
      };
    });
    return {
      payload: {
        ...payload,
        input: Array.isArray(payload.input) && payload.input.length ? payload.input : materializedInput,
      },
      context: {
        input: Array.isArray(payload.input) && payload.input.length ? payload.input : materializedInput,
      },
    };
  }),
  planResponsesRequestContext: jest.fn((input: { payload?: Record<string, unknown> }) => {
    const payload = input.payload ?? {};
    return {
      kind: 'context',
      payload,
      context: {
        input: Array.isArray(payload.input) ? payload.input : [],
      },
    };
  }),
  planResponsesContinuationRequestAction: jest.fn((input: {
    responseId?: string;
    continuation?: Record<string, unknown> | null;
  }) => {
    const continuation = input.continuation && typeof input.continuation === 'object'
      ? input.continuation
      : {};
    const responseId = input.responseId;
    if (continuation.continuationOwner === 'direct') {
      return {
        action: 'direct_submit',
        responseId,
        pipelineEntryEndpoint: '/v1/responses.submit_tool_outputs',
        materializeProviderOwnedSubmitContext: true,
        resumeMeta: {
          providerKey: continuation.providerKey,
          continuationOwner: 'direct',
          responseId,
          restored: false,
        },
      };
    }
    if (continuation.continuationOwner === 'relay') {
      return {
        action: 'relay_submit',
        responseId,
        pipelineEntryEndpoint: '/v1/responses',
      };
    }
    return { action: 'none' };
  }),
  buildAnthropicResponseFromChatJson: jest.fn(async (input: unknown) => input),
  sanitizeProviderOutboundPayload: jest.fn(async (input: unknown) => input),
  hasDeclaredApplyPatchToolNative: jest.fn(() => false),
  evaluateSingletonRoutePoolExhaustionNative: jest.fn(() => ({ exhausted: false })),
  planPrimaryExhaustedToDefaultPoolNative: jest.fn(() => ({ status: 'unmatched', defaultPoolTargets: [] })),
  planResponsesRequestBodyForHttpNative: jest.fn(planResponsesRequestBodyForHttpMock),
  shouldManageResponsesConversationForHttpNative: jest.fn((entryEndpoint?: string) =>
    entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs'
  ),
  buildResponsesScopeContinuationExpiredErrorForHttpNative: jest.fn(() => ({
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  })),
  buildResponsesResumeClientErrorForHttpNative: jest.fn((args: {
    status?: number;
    code?: string;
    origin?: string;
    message?: string;
  } = {}) => ({
    status: typeof args.status === 'number' ? args.status : 422,
    body: {
      error: {
        message: typeof args.message === 'string' && args.message.trim()
          ? args.message
          : 'Unable to resume Responses conversation',
        type: 'invalid_request_error',
        code: typeof args.code === 'string' && args.code.trim()
          ? args.code
          : 'responses_resume_failed',
        origin: typeof args.origin === 'string' && args.origin.trim()
          ? args.origin
          : 'client',
      },
    },
  })),
  shouldProjectResponsesResumeClientErrorForHttpNative: jest.fn((origin?: string) =>
    typeof origin === 'string' && origin.trim() === 'client'
  ),
  buildResponsesResumeControlForContinuationContextForHttpNative: jest.fn(
    buildResponsesResumeControlForContinuationContextForHttpFake
  ),
  buildResponsesConversationPortScopeForHttpNative: jest.fn(() => ({})),
  planResponsesHandlerStreamForHttpNative: jest.fn((args: {
    payload?: Record<string, unknown>;
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
  }),
  convertResponsesRequestToChatNative: jest.fn((input: unknown) => input),
  normalizeResponsesDirectCurrentRequestPayload: jest.fn((input: unknown) => input),
  evaluateResponsesDirectRouteDecisionNative: jest.fn(() => ({ providerWireValid: true, requiresHubRelay: false })),
  extractSessionIdentifiersFromMetadataNative: jest.fn((metadata?: Record<string, unknown>) => ({
    sessionId: metadata?.sessionId ?? metadata?.session_id,
    conversationId: metadata?.conversationId ?? metadata?.conversation_id,
  })),
  buildResponsesPayloadFromChatNative: jest.fn((input: unknown) => input),
  projectResponsesClientPayloadForClientNative: jest.fn((args: { payload?: unknown }) => args.payload ?? {}),
  projectResponsesSseFrameForClientNative: jest.fn((args: { frame?: string }) => ({
    emit: true,
    frame: args.frame ?? '',
    state: undefined,
  })),
  projectSseErrorEventPayloadNative: jest.fn((args: unknown) => args),
  describeHubPipelineContractsNative: jest.fn(() => ({})),
  describeVirtualRouterContractsNative: jest.fn(() => ({})),
  describeMetaCarrierContractsNative: jest.fn(() => ({})),
  describePipelineContractNative: jest.fn(() => ({})),
  validatePipelineNodeContractBoundaryNative: jest.fn(() => ({ valid: true })),
  classifyProviderFailure: jest.fn(() => ({ classification: 'unknown' })),
  deriveFinishReasonNative: jest.fn(() => undefined),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  isEmptyClientResponsePayloadNative: jest.fn(() => false),
  shouldRecordSnapshotsNative: jest.fn(() => false),
  writeSnapshotViaHooksNative: jest.fn(() => undefined),
  classifyEmptyResponseSignalNative: jest.fn(() => ({ isEmpty: false, empty: false, reason: undefined })),
  detectToolExecutionFailuresNative: jest.fn(() => []),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn((input: {
    request?: Record<string, unknown>;
  }) => {
    const request = input.request ?? {};
    const toolOutputs = Array.isArray(request.tool_outputs) ? request.tool_outputs : [];
    const first = toolOutputs[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      return undefined;
    }
    const output = (first as Record<string, unknown>).output;
    if (typeof output !== 'string' || !output.trim()) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return typeof parsed.routeHint === 'string' ? parsed.routeHint : undefined;
    } catch {
      return undefined;
    }
  }),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  buildResponsesJsonFromSseStreamWithNative: jest.fn(async () => ({})),
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearAllResponsesConversationState: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: mockClearResponsesConversationByRequestId,
  clearUnresolvedResponsesConversationRequests: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(async () => ({ convertResponseToJsonToSse: async () => ({}) })),
  createResponsesSseToJsonConverter: jest.fn(async () => ({ convertSseToJson: async () => ({}) })),
  finalizeResponsesConversationRequestRetention: mockFinalizeResponsesConversationRequestRetention,
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: mockRecordResponsesResponseForRequest,
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  reportProviderErrorToRouterPolicy: jest.fn(async () => undefined),
  reportProviderSuccessToRouterPolicy: jest.fn(async () => undefined),
  resetResponsesConversationStateForRestartSimulation: jest.fn(async () => undefined),
  resumeResponsesConversation: mockResumeResponsesConversation,
  resumeLatestResponsesContinuationByScope: mockResumeLatestResponsesContinuationByScope,
  writeSnapshotViaHooks: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.js', createNativeExportsMock);

jest.unstable_mockModule('../../../src/utils/system-prompt-loader.js', () => ({
  applySystemPromptOverride: jest.fn(),
}));

jest.unstable_mockModule('../../../src/utils/errorsamples.js', () => ({
  writeErrorsampleJson: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../../src/server/utils/finish-reason.js', () => ({
  STREAM_LOG_FINISH_REASON_KEY: '__routecodex_finish_reason',
  deriveFinishReason: jest.fn((body: Record<string, unknown> | undefined) => {
    const output = Array.isArray(body?.output) ? body.output : [];
    if (output.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call')) {
      return 'tool_calls';
    }
    return body?.status === 'completed' ? 'stop' : undefined;
  }),
}));

const createResponsesBridgeMock = () => ({
  assertDirectPassthroughResponsesSseFrameForHttp: jest.fn(() => undefined),
  assertDirectPassthroughResponsesSseMetadataIsolationForHttp: jest.fn(() => undefined),
  buildClientSseKeepaliveFrameForHttp: jest.fn(() => ': keepalive\n\n'),
  buildResponsesMissingSseBridgeErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'SSE stream missing from pipeline result', code: 'sse_bridge_error' },
  })),
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  buildResponsesSseErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'Upstream provider error', code: 'INTERNAL_ERROR' },
  })),
  buildResponsesStreamIncompleteErrorPayloadForHttp: jest.fn(() => ({
    type: 'error',
    error: { message: 'stream closed before response.completed', code: 'upstream_stream_incomplete' },
  })),
  buildResponsesStructuredSseErrorPayloadForHttp: jest.fn((_error: unknown, args?: { status?: number }) => ({
    type: 'error',
    status: args?.status ?? 500,
    error: { message: 'Upstream provider error', code: 'INTERNAL_ERROR' },
  })),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  createResponsesSseClientProjectionStateForHttp: jest.fn(() => ({})),
  createResponsesJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  createChatJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  inspectResponsesTerminalStateFromSseChunkForHttp: jest.fn(() => ({ sawTerminalChunk: false })),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn(() => false),
  sanitizeDirectPassthroughResponsesSseFrameForHttp: jest.fn((frame: string) => frame),
  normalizeChatUsagePayloadForHttp: jest.fn((body: unknown) => ({
    payload: body,
    normalized: false,
    source: undefined,
  })),
  normalizeResponsesClientPayloadForHttp: jest.fn((payload: unknown) => payload),
  normalizeResponsesJsonBodyForHttp: jest.fn((payload: unknown) => payload),
  normalizeResponsesSseFrameForClientForHttp: jest.fn((frame: string) => frame),
  planResponsesContinuationCloseActionForHttp: jest.fn(() => ({ action: 'none' })),
  planResponsesStreamEndRepairForHttp: jest.fn(() => ({ shouldRepair: false })),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn((body: unknown) => body),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(async (args: { body: unknown }) => ({
    clientBody: args.body,
    sanitizedBody: args.body,
    finishReason: undefined,
  })),
  projectResponsesSseFrameForClientForHttp: jest.fn((input: { frame?: string; state?: unknown }) => ({
    emit: true,
    frame: input.frame ?? '',
    state: input.state,
  })),
  rebindResponsesConversationRequestIdForHttp: jest.fn(async () => undefined),
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn(() => undefined),
  resolveResponsesRequestContextForHttp: jest.fn((args: { fallback?: unknown }) => args.fallback),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => undefined),
  resolveResponsesTerminalProbeFinishReasonForHttp: jest.fn(() => undefined),
  shouldClearResponsesConversationOnClientCloseForHttp: jest.fn(() => false),
  shouldClearResponsesConversationOnFailureForHttp: jest.fn(() => false),
  shouldDispatchResponsesSseToClientForHttp: jest.fn(() => false),
  shouldRequireResponsesTerminalEventForHttp: jest.fn(() => false),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => ({ kind: 'sse_frame' })),
  updateResponsesSseTransportTerminalStateForHttp: jest.fn((input: { chunk?: unknown; state?: Record<string, unknown> }) => ({
    state: input.state ?? {},
    observedTerminal: String(input.chunk ?? '').includes('response.completed') || String(input.chunk ?? '').includes('response.done'),
  })),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', createResponsesBridgeMock);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-sse-bridge.js', createResponsesBridgeMock);

describe('responses-handler submit_tool_outputs same-protocol responses routing', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResumeResponsesConversation.mockReset();
    mockLookupResponsesContinuationByResponseId.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockReset();
    mockClearResponsesConversationByRequestId.mockReset();
    mockFinalizeResponsesConversationRequestRetention.mockReset();
    mockMaterializeLatestResponsesContinuationByScope.mockReset();
    mockResumeLatestResponsesContinuationByScope.mockReset();
    mockRecordResponsesResponseForRequest.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockResolvedValue(undefined);
    mockClearResponsesConversationByRequestId.mockResolvedValue(undefined);
    mockFinalizeResponsesConversationRequestRetention.mockResolvedValue(undefined);
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValue(null);
    mockResumeLatestResponsesContinuationByScope.mockResolvedValue(null);
    mockRecordResponsesResponseForRequest.mockResolvedValue(undefined);
    mockLookupResponsesContinuationByResponseId.mockResolvedValue(null);
  });

  it('RED: direct submit_tool_outputs must not local-resume and must forward native submit payload with provider pin only', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_submit_direct_1',
      providerKey: 'dibittai.crsa.gpt-5.4',
      continuationOwner: 'direct',
      entryKind: 'responses',
    });

    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_after_submit_direct_1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      },
    }));

    const req = {
      method: 'POST',
      body: {
        tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
      },
      headers: {},
      query: {},
      path: '/v1/responses/resp_submit_direct_1/submit_tool_outputs',
      originalUrl: '/v1/responses/resp_submit_direct_1/submit_tool_outputs',
      params: { id: 'resp_submit_direct_1' },
      socket: { localPort: 5555 },
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
      on: jest.fn(),
      once: jest.fn(),
    } as any;

    await handleResponses(
      req,
      res,
      {
        executePipeline,
        errorHandling: null,
      },
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        responseIdFromPath: 'resp_submit_direct_1',
      },
    );

    expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
      'resp_submit_direct_1',
      expect.objectContaining({ entryKind: 'responses' }),
    );
    expect(mockResumeResponsesConversation).not.toHaveBeenCalled();
    const pipelineInput = executePipeline.mock.calls[0]?.[0];
    expect(pipelineInput.entryEndpoint).toBe('/v1/responses.submit_tool_outputs');
    expect(pipelineInput.hubBody).toEqual({
      response_id: 'resp_submit_direct_1',
      previous_response_id: 'resp_submit_direct_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_submit_direct_1',
          output: 'ok',
        },
      ],
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
    });
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).toMatchObject({
      continuationOwner: 'direct',
      providerKey: 'dibittai.crsa.gpt-5.4',
      responseId: 'resp_submit_direct_1',
      restored: false,
    });
    expect(MetadataCenter.read(pipelineInput.metadata)?.readRuntimeControl().retryProviderKey).toBe('dibittai.crsa.gpt-5.4');
  });

  it('rewrites relay submit_tool_outputs back to /v1/responses mainline after local materialization', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_submit_same_protocol_1',
      providerKey: 'dibittai.crsa.gpt-5.4',
      continuationOwner: 'relay',
      entryKind: 'responses',
    });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_submit_same_protocol_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs 同协议直连' }],
          },
          {
            type: 'function_call',
            id: 'fc_submit_same_protocol_1',
            call_id: 'call_submit_same_protocol_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
          {
            type: 'function_call_output',
            id: 'fc_submit_same_protocol_1',
            call_id: 'call_submit_same_protocol_1',
            output: 'ok',
          },
        ],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_same_protocol_1',
        routeHint: 'thinking',
        continuationOwner: 'relay',
      },
    });

    const executePipeline = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        id: 'resp_after_submit_same_protocol_1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      },
    }));

    const req = {
      method: 'POST',
      body: {
        tool_outputs: [{ call_id: 'call_submit_same_protocol_1', output: 'ok' }],
      },
      headers: {},
      query: {},
      path: '/v1/responses/resp_submit_same_protocol_1/submit_tool_outputs',
      originalUrl: '/v1/responses/resp_submit_same_protocol_1/submit_tool_outputs',
      params: { id: 'resp_submit_same_protocol_1' },
      socket: { localPort: 5555 },
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
      on: jest.fn(),
      once: jest.fn(),
    } as any;

    await handleResponses(
      req,
      res,
      {
        executePipeline,
        errorHandling: null,
      },
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        responseIdFromPath: 'resp_submit_same_protocol_1',
      },
    );

    expect(mockResumeResponsesConversation).toHaveBeenCalledWith(
      'resp_submit_same_protocol_1',
      {
        response_id: 'resp_submit_same_protocol_1',
        tool_outputs: [{ call_id: 'call_submit_same_protocol_1', output: 'ok' }],
      },
      expect.objectContaining({ requestId: expect.any(String), entryKind: 'responses' }),
    );
    expect(executePipeline).toHaveBeenCalledTimes(1);
    const pipelineInput = executePipeline.mock.calls[0]?.[0];
    expect(pipelineInput.entryEndpoint).toBe('/v1/responses');
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).toMatchObject({
      continuationOwner: 'relay',
    });
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(pipelineInput.hubBody?.previous_response_id).toBe('resp_submit_same_protocol_1');
    expect(pipelineInput.hubBody?.tool_outputs).toBeUndefined();
    expect(pipelineInput.hubBody?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_submit_same_protocol_1' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_submit_same_protocol_1',
          output: 'ok',
        }),
      ]),
    );
  });

  it('RED: submit_tool_outputs capture must preserve providerKey pin so direct continuation can stay on the same provider', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_submit_same_provider_pin_1',
      providerKey: 'dibittai.crsa.gpt-5.4',
      continuationOwner: 'relay',
      entryKind: 'responses',
    });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_submit_same_provider_pin_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 direct submit_tool_outputs' }],
          },
        ],
        tool_outputs: [{ call_id: 'call_submit_same_provider_pin_1', output: 'ok' }],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_same_provider_pin_1',
        routeHint: 'thinking',
        providerKey: 'dibittai.crsa.gpt-5.4',
        sessionId: 'sess-submit-same-provider-pin-1',
        conversationId: 'conv-submit-same-provider-pin-1',
      },
    });

    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_after_submit_same_provider_pin_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_submit_same_provider_pin_1',
            call_id: 'call_submit_same_provider_pin_2',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
        ],
      },
      usageLogInfo: {
        providerKey: 'dibittai.crsa.gpt-5.4',
        timingRequestIds: ['openai-responses-dibittai.crsa-gpt-5.4-20260526T000000000-1-1'],
      },
    }));

    const req = {
      method: 'POST',
      body: {
        tool_outputs: [{ call_id: 'call_submit_same_provider_pin_1', output: 'ok' }],
      },
      headers: {},
      query: {},
      path: '/v1/responses/resp_submit_same_provider_pin_1/submit_tool_outputs',
      originalUrl: '/v1/responses/resp_submit_same_provider_pin_1/submit_tool_outputs',
      params: { id: 'resp_submit_same_provider_pin_1' },
      socket: { localPort: 5555 },
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
      on: jest.fn(),
      once: jest.fn(),
    } as any;

    await handleResponses(
      req,
      res,
      {
        executePipeline,
        errorHandling: null,
      },
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        responseIdFromPath: 'resp_submit_same_provider_pin_1',
      },
    );

    expect(mockCaptureResponsesRequestContextForRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        entryKind: 'responses',
        providerKey: 'dibittai.crsa.gpt-5.4',
      }),
    );
    const pipelineInput = executePipeline.mock.calls[0]?.[0];
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).toMatchObject({
      restoredFromResponseId: 'resp_submit_same_provider_pin_1',
    });
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(MetadataCenter.read(pipelineInput.metadata)?.readContinuationContext().responsesResume).not.toHaveProperty('providerKey');
    const center = MetadataCenter.read(pipelineInput.metadata);
    expect(center?.readRequestTruth()).toEqual(expect.objectContaining({
      requestId: expect.any(String),
      clientRequestId: expect.any(String),
    }));
    expect(center?.readRuntimeControl().routeHint).toBeUndefined();
    expect(center?.readRuntimeControl().retryProviderKey).toBeUndefined();
  });

  it('RED: relay submit_tool_outputs follow-up requires_action must persist the new response id for the next submit', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const bridge = await import('../../../src/modules/llmswitch/bridge/responses-response-bridge.js');

    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_submit_followup_1',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      continuationOwner: 'relay',
      entryKind: 'responses',
      requestId: 'openai-responses-router-submit-followup-1',
    });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.5',
        previous_response_id: 'resp_submit_followup_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'continue submit follow-up' }],
          },
          {
            type: 'function_call',
            id: 'fc_submit_followup_1',
            call_id: 'call_submit_followup_1',
            name: 'exec_command',
            arguments: '{"cmd":"routecodex hook run reasoningStop --input-json \\"{}\\""}',
          },
          {
            type: 'function_call_output',
            id: 'fc_submit_followup_1',
            call_id: 'call_submit_followup_1',
            output: '{"ok":true,"kind":"stop_message_auto"}',
          },
        ],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_followup_1',
        routeHint: 'search',
        continuationOwner: 'relay',
        sessionId: 'sess-submit-followup-1',
        conversationId: 'conv-submit-followup-1',
      },
    });

    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_submit_followup_2',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            id: 'fc_submit_followup_2',
            call_id: 'call_submit_followup_2',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_submit_followup_2',
                type: 'function',
                name: 'exec_command',
                arguments: '{"cmd":"pwd"}',
                tool_call_id: 'call_submit_followup_2',
              },
            ],
          },
        },
      },
      usageLogInfo: {
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        timingRequestIds: ['openai-responses-minimonth.key1-MiniMax-M2.7-20260622T000000000-1-1'],
        sessionId: 'sess-submit-followup-1',
        conversationId: 'conv-submit-followup-1',
      },
    }));

    const req = {
      method: 'POST',
      body: {
        tool_outputs: [{ call_id: 'call_submit_followup_1', output: '{"ok":true,"kind":"stop_message_auto"}' }],
      },
      headers: {},
      query: {},
      path: '/v1/responses/resp_submit_followup_1/submit_tool_outputs',
      originalUrl: '/v1/responses/resp_submit_followup_1/submit_tool_outputs',
      params: { id: 'resp_submit_followup_1' },
      socket: { localPort: 5555 },
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
      on: jest.fn(),
      once: jest.fn(),
    } as any;

    await handleResponses(
      req,
      res,
      {
        executePipeline,
        errorHandling: null,
      },
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        responseIdFromPath: 'resp_submit_followup_1',
      },
    );

    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(executePipeline.mock.calls[0]?.[0]?.entryEndpoint).toBe('/v1/responses');
  });

  it('binds resumed relay request truth and runtime pin into MetadataCenter before executePipeline', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockLookupResponsesContinuationByResponseId.mockResolvedValue({
      responseId: 'resp_submit_metadata_center_1',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      continuationOwner: 'relay',
      entryKind: 'responses',
    });
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.5',
        previous_response_id: 'resp_submit_metadata_center_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs metadata center 续轮' }],
          },
          {
            type: 'function_call',
            id: 'fc_submit_metadata_center_1',
            call_id: 'call_submit_metadata_center_1',
            name: 'reasoningStop',
            arguments: '{"reason":"第一轮故意缺 schema","stopreason":2}',
          },
          {
            type: 'function_call_output',
            id: 'fc_submit_metadata_center_1',
            call_id: 'call_submit_metadata_center_1',
            output: '{"ok":true}',
          },
        ],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_metadata_center_1',
        routeHint: 'search/gateway-priority-5555-priority-search',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'sess-submit-metadata-center-1',
        conversationId: 'conv-submit-metadata-center-1',
        continuationOwner: 'relay',
      },
    });

    const executePipeline = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_after_submit_metadata_center_1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      },
    }));

    const req = {
      method: 'POST',
      body: {
        tool_outputs: [{ call_id: 'call_submit_metadata_center_1', output: 'ok' }],
      },
      headers: {},
      query: {},
      path: '/v1/responses/resp_submit_metadata_center_1/submit_tool_outputs',
      originalUrl: '/v1/responses/resp_submit_metadata_center_1/submit_tool_outputs',
      params: { id: 'resp_submit_metadata_center_1' },
      socket: { localPort: 5555 },
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
      on: jest.fn(),
      once: jest.fn(),
    } as any;

    await handleResponses(
      req,
      res,
      {
        executePipeline,
        errorHandling: null,
      },
      {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        responseIdFromPath: 'resp_submit_metadata_center_1',
      },
    );

    const pipelineInput = executePipeline.mock.calls[0]?.[0];
    const center = MetadataCenter.read(pipelineInput.metadata);
    expect(center?.readRequestTruth()).toEqual(expect.objectContaining({
      requestId: expect.any(String),
      clientRequestId: expect.any(String),
    }));
    expect(center?.readContinuationContext().responsesResume).toMatchObject({
      continuationOwner: 'relay'
    });
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('providerKey');
    expect(center?.readContinuationContext().responsesResume).not.toHaveProperty('routeHint');
    expect(center?.readRuntimeControl().routeHint).toBeUndefined();
    expect(center?.readRuntimeControl().retryProviderKey).toBeUndefined();
  });
});
