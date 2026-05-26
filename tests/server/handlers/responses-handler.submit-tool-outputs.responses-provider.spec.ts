import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResumeResponsesConversation = jest.fn();
const mockCaptureResponsesRequestContextForRequest = jest.fn();

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  finalizeResponsesConversationRequestRetention: jest.fn(),
  importCoreDist: jest.fn(),
  recordResponsesResponseForRequest: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(),
  resumeResponsesConversation: mockResumeResponsesConversation,
  requireCoreDist: jest.fn(() => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: () => ({}),
  })),
}));

describe('responses-handler submit_tool_outputs same-protocol responses routing', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResumeResponsesConversation.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockReset();
    mockCaptureResponsesRequestContextForRequest.mockResolvedValue(undefined);
  });

  it('RED: keeps submit_tool_outputs entryEndpoint for responses providers so upstream can use native submit path', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_submit_same_protocol_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs 同协议直连' }],
          },
        ],
        tool_outputs: [{ call_id: 'call_submit_same_protocol_1', output: 'ok' }],
      },
      meta: {
        restoredFromResponseId: 'resp_submit_same_protocol_1',
        routeHint: 'thinking',
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
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(executePipeline).toHaveBeenCalledTimes(1);
    const pipelineInput = executePipeline.mock.calls[0]?.[0];
    expect(pipelineInput.entryEndpoint).toBe('/v1/responses.submit_tool_outputs');
    expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
    expect(pipelineInput.body?.previous_response_id).toBe('resp_submit_same_protocol_1');
    expect(mockCaptureResponsesRequestContextForRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        payload: expect.objectContaining({
          previous_response_id: 'resp_submit_same_protocol_1',
          tool_outputs: [{ call_id: 'call_submit_same_protocol_1', output: 'ok' }],
        }),
        context: expect.objectContaining({
          input: expect.any(Array),
        }),
        routeHint: 'thinking',
      }),
    );
  });

  it('RED: submit_tool_outputs capture must preserve providerKey pin so direct continuation can stay on the same provider', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');

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
        routeHint: 'thinking',
        providerKey: 'dibittai.crsa.gpt-5.4',
      }),
    );
  });
});
