import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createBridgeHttpServerMock } from '../../helpers/bridge-http-server-mock.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockResumeResponsesConversation = jest.fn();
const mockLookupResponsesContinuationByResponseId = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();
const mockClearResponsesConversationByRequestId = jest.fn(async () => undefined);
const mockFinalizeResponsesConversationRequestRetention = jest.fn(async () => undefined);
const mockMaterializeLatestResponsesContinuationByScope = jest.fn(async () => null);
const mockRecordResponsesResponseForRequest = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId: mockClearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention: mockFinalizeResponsesConversationRequestRetention,
  lookupResponsesContinuationByResponseId: mockLookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest: mockRecordResponsesResponseForRequest,
  resumeResponsesConversation: mockResumeResponsesConversation,
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
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
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.ts', () => ({
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
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
}));

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
  ...createBridgeHttpServerMock(),
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
  buildResponsesTerminalSseFramesFromProbeForHttp: jest.fn(() => []),
  clearResponsesConversationRequestIdsForHttp: jest.fn(async () => undefined),
  createResponsesJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  createChatJsonToSseConverterForHttp: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => ({})
  })),
  finalizeResponsesConversationRequestRetentionForHttp: jest.fn(async () => undefined),
  importResponsesHandlerCoreDist: jest.fn(async () => ({})),
  inspectResponsesTerminalStateFromSseChunkForHttp: jest.fn(() => ({ sawTerminalChunk: false })),
  isDirectPassthroughTransportKeepaliveFrameForHttp: jest.fn(() => false),
  normalizeChatUsagePayloadForHttp: jest.fn((body: unknown) => ({
    payload: body,
    normalized: false,
    source: undefined,
  })),
  normalizeResponsesSseFrameForClientForHttp: jest.fn((frame: string) => frame),
  persistResponsesConversationLifecycleForHttp: jest.fn(async () => undefined),
  planResponsesContinuationCloseActionForHttp: jest.fn(() => ({ action: 'none' })),
  planResponsesStreamEndRepairForHttp: jest.fn(() => ({ shouldRepair: false })),
  prepareResponsesJsonBodyForSseBridgeForHttp: jest.fn((body: unknown) => body),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(async (args: { body: unknown }) => ({
    clientBody: args.body,
    sanitizedBody: args.body,
    finishReason: undefined,
  })),
  prepareResponsesJsonSseDispatchPlanForHttp: jest.fn(async (args: { responsesPayload?: unknown }) => ({
    normalizedPayload: args.responsesPayload,
    sanitizedPayload: args.responsesPayload,
    finishReason: 'tool_calls',
  })),
  resolveResponsesClientPayloadFinishReasonForHttp: jest.fn(() => undefined),
  resolveResponsesRequestContextForHttp: jest.fn((args: { fallback?: unknown }) => args.fallback),
  resolveResponsesConversationClearReasonForHttp: jest.fn((reason: string) => reason),
  resolveResponsesProviderProtocolHintFromSseFrameForHttp: jest.fn(() => undefined),
  resolveResponsesTerminalProbeFinishReasonForHttp: jest.fn(() => undefined),
  shouldClearResponsesConversationOnClientCloseForHttp: jest.fn(() => false),
  shouldClearResponsesConversationOnFailureForHttp: jest.fn(() => false),
  shouldDispatchResponsesSseToClientForHttp: jest.fn(() => false),
  shouldDropClientSseFrameForHttp: jest.fn(() => false),
  shouldPersistResponsesContinuationOnProbeUpdateForHttp: jest.fn(() => false),
  shouldPersistResponsesConversationStateForHttp: jest.fn(() => false),
  shouldRequireResponsesTerminalEventForHttp: jest.fn(() => false),
  summarizeResponsesSseFrameForLogForHttp: jest.fn(() => ({ kind: 'sse_frame' })),
  updateResponsesContractProbeFromSseChunkForHttp: jest.fn((_chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
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
    mockRecordResponsesResponseForRequest.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockResolvedValue(undefined);
    mockClearResponsesConversationByRequestId.mockResolvedValue(undefined);
    mockFinalizeResponsesConversationRequestRetention.mockResolvedValue(undefined);
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValue(null);
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
    expect(pipelineInput.body).toEqual({
      response_id: 'resp_submit_direct_1',
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
    });
    expect(pipelineInput.metadata?.responsesResume).toMatchObject({
      providerKey: 'dibittai.crsa.gpt-5.4',
      continuationOwner: 'direct',
      responseId: 'resp_submit_direct_1',
      restored: false,
    });
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
    expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
    expect(pipelineInput.metadata?.responsesResume?.routeHint).toBe('thinking');
    expect(pipelineInput.body?.previous_response_id).toBe('resp_submit_same_protocol_1');
    expect(pipelineInput.body?.tool_outputs).toBeUndefined();
    expect(pipelineInput.body?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_submit_same_protocol_1' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_submit_same_protocol_1',
          output: 'ok',
        }),
      ]),
    );
    expect(mockCaptureResponsesRequestContextForRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        entryKind: 'responses',
        payload: expect.objectContaining({
          previous_response_id: 'resp_submit_same_protocol_1',
          input: expect.arrayContaining([
            expect.objectContaining({ type: 'function_call', call_id: 'call_submit_same_protocol_1' }),
            expect.objectContaining({
              type: 'function_call_output',
              call_id: 'call_submit_same_protocol_1',
              output: 'ok',
            }),
          ]),
        }),
        context: expect.objectContaining({
          input: expect.any(Array),
        }),
      }),
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
    expect(pipelineInput.metadata?.responsesResume?.routeHint).toBe('thinking');
    expect(pipelineInput.metadata?.responsesResume?.sessionId).toBe('sess-submit-same-provider-pin-1');
    expect(pipelineInput.metadata?.responsesResume?.conversationId).toBe('conv-submit-same-provider-pin-1');
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

    expect((bridge.persistResponsesConversationLifecycleForHttp as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        entryEndpoint: '/v1/responses',
        requestContext: expect.objectContaining({
          payload: expect.objectContaining({
            previous_response_id: 'resp_submit_followup_1',
          }),
          context: expect.objectContaining({
            input: expect.any(Array),
          }),
        }),
        body: expect.objectContaining({
          body: expect.objectContaining({
            id: 'resp_submit_followup_2',
            status: 'requires_action',
          }),
        }),
      }),
    );
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
    expect(center?.readRequestTruth()).toMatchObject({
      sessionId: 'sess-submit-metadata-center-1',
      conversationId: 'conv-submit-metadata-center-1'
    });
    expect(center?.readContinuationContext().responsesResume).toMatchObject({
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      routeHint: 'search/gateway-priority-5555-priority-search',
      sessionId: 'sess-submit-metadata-center-1',
      conversationId: 'conv-submit-metadata-center-1',
      continuationOwner: 'relay'
    });
    expect(center?.readRuntimeControl()).toMatchObject({
      routeHint: 'search/gateway-priority-5555-priority-search'
    });
    expect(center?.readRuntimeControl().retryProviderKey).toBeUndefined();
  });
});
