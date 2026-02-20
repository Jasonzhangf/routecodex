import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn(async () => ({ body: { id: 'mock' } }));
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder
});
const mockInjectClockClientPromptWithResult = jest.fn(async () => ({ ok: true }));
const mockUnbindConversationSession = jest.fn();
const mockGetClockClientRegistry = jest.fn(() => ({
  unbindConversationSession: mockUnbindConversationSession
}));
const mockClockRegistryModule = () => ({
  injectClockClientPromptWithResult: mockInjectClockClientPromptWithResult,
  getClockClientRegistry: mockGetClockClientRegistry
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/server/runtime/http-server/clock-client-registry.js', mockClockRegistryModule);
jest.unstable_mockModule('../../../../../src/server/runtime/http-server/clock-client-registry.ts', mockClockRegistryModule);

describe('provider-response-converter servertool regressions', () => {
  it('disables servertool orchestration when serverToolsEnabled=false', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_toggle_off',
        serverToolsEnabled: false,
        wantsStream: false,
        response: { body: { id: 'upstream' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const call = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(call.providerInvoker).toBeUndefined();
    expect(call.reenterPipeline).toBeUndefined();
    expect(call.context?.serverToolsEnabled).toBe(false);
    expect(call.context?.serverToolsDisabled).toBe(true);
  });

  it('keeps servertool orchestration enabled by default', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_toggle_on',
        wantsStream: false,
        response: { body: { id: 'upstream' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const call = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(typeof call.providerInvoker).toBe('function');
    expect(typeof call.reenterPipeline).toBe('function');
    expect(call.context?.serverToolsEnabled).toBe(true);
    expect(call.context?.serverToolsDisabled).toBeUndefined();
  });

  it('preserves followup session headers and strips clientRequestId', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ reenterPipeline }) => {
      await reenterPipeline({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_1',
        body: { messages: [{ role: 'user', content: 'continue' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          clientHeaders: {
            'anthropic-session-id': 'sess_123',
            'anthropic-conversation-id': 'conv_456',
            authorization: 'Bearer should-not-forward'
          },
          clientRequestId: 'req_from_client'
        }
      });
      return { body: { type: 'message', id: 'msg_followup' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_root_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {
          clientHeaders: {
            'anthropic-session-id': 'sess_123',
            'anthropic-conversation-id': 'conv_456'
          }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect(executeNested).toHaveBeenCalledTimes(1);
    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    const nestedMetadata = nestedInput?.metadata as Record<string, any>;

    expect(nestedMetadata.clientHeaders).toEqual({
      'anthropic-session-id': 'sess_123',
      'anthropic-conversation-id': 'conv_456'
    });
    expect(nestedMetadata.clientRequestId).toBeUndefined();
    expect(nestedMetadata.sessionId).toBe('sess_123');
    expect(nestedMetadata.conversationId).toBe('conv_456');
  });

  it('maps deepseek context-length SSE decode errors to explicit 400 error', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[chat_process.resp.stage1.sse_decode] ... context_length_exceeded'),
        {
          name: 'ProviderProtocolError',
          code: 'SSE_DECODE_ERROR',
          details: {
            upstreamCode: 'context_length_exceeded',
            reason: 'context_length_exceeded'
          }
        }
      );
      throw err;
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'openai-chat',
          requestId: 'req_ctx_len_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata: {}
        },
        {
          runtimeManager: {
            resolveRuntimeKey: () => undefined,
            getHandleByRuntimeKey: () => undefined
          },
          executeNested: async () => ({ body: { ok: true } } as any)
        }
      )
    ).rejects.toMatchObject({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      status: 400,
      statusCode: 400
    });
  });

  it('fails followup when client inject cannot resolve tmux binding and unbinds stale session', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockInjectClockClientPromptWithResult.mockResolvedValue({
      ok: false,
      reason: 'no_matching_tmux_session_daemon'
    });
    mockGetClockClientRegistry.mockClear();
    mockUnbindConversationSession.mockReset();

    mockConvertProviderResponse.mockImplementation(async ({ reenterPipeline }) => {
      await reenterPipeline({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_inject_fail',
        body: { messages: [{ role: 'user', content: '继续执行' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionId: 'sess_stale',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.continue_execution'
        }
      });
      return { body: { type: 'message', id: 'msg_followup_should_not_reach' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'anthropic-messages',
          requestId: 'req_inject_fail_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata: {}
        },
        {
          runtimeManager: {
            resolveRuntimeKey: () => undefined,
            getHandleByRuntimeKey: () => undefined
          },
          executeNested: async () => ({ body: { ok: true } } as any)
        }
      )
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'clock_client_inject_failed'
    });

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockGetClockClientRegistry).toHaveBeenCalled();
    expect(mockUnbindConversationSession).toHaveBeenCalledWith('sess_stale');
  });
});
