import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

// Jest ESM resolver can map `.js` imports to `.ts` source.
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider-response-converter serverTool followup metadata', () => {
  it('keeps session continuity headers while dropping clientRequestId', async () => {
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
      'anthropic-conversation-id': 'conv_456',
      authorization: 'Bearer should-not-forward'
    });
    expect(nestedMetadata.clientRequestId).toBeUndefined();
    expect(nestedMetadata.sessionId).toBe('sess_123');
    expect(nestedMetadata.conversationId).toBe('conv_456');
  });

  it('backfills capturedChatRequest from originalRequest when metadata carries null placeholder', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async ({ context }) => {
      return {
        body: {
          id: 'msg_ok',
          observedCaptured: context?.capturedChatRequest
        }
      };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const originalRequest = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hi' }]
    };

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        requestId: 'req_captured_backfill_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body', choices: [] } } as any,
        originalRequest,
        pipelineMetadata: {
          capturedChatRequest: null
        }
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
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.context?.capturedChatRequest).toEqual(originalRequest);
  });

  it('backfills capturedChatRequest.tools from requestSemantics clientToolsRaw when captured request lost tools', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async ({ context }) => {
      return {
        body: {
          id: 'msg_ok',
          observedCaptured: context?.capturedChatRequest
        }
      };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const capturedChatRequest = {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'audit project' }]
    };
    const clientToolsRaw = [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }
      }
    ];

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_captured_tools_backfill_1',
        wantsStream: false,
        response: { body: { id: 'resp_ok', output: [] } } as any,
        originalRequest: { response_id: 'resp_1', tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }] },
        requestSemantics: {
          tools: {
            clientToolsRaw
          }
        } as any,
        pipelineMetadata: {
          capturedChatRequest
        }
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
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.context?.capturedChatRequest).toMatchObject({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'audit project' }],
      tools: clientToolsRaw
    });
  });

  it('backfills session identifiers from originalRequest metadata before syncing stopless state', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockReset();
    mockSyncReasoningStopModeFromRequest.mockImplementation(() => 'on');

    mockConvertProviderResponse.mockImplementation(async ({ context }) => ({
      body: {
        id: 'msg_ok',
        observedSessionId: context?.sessionId,
        observedConversationId: context?.conversationId
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_stopless_session_backfill_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body', choices: [] } } as any,
        originalRequest: {
          model: 'qwen3.6-plus',
          input: '<**stopless:on**> hi',
          metadata: {
            sessionId: 'sess_stopless_1',
            conversationId: 'conv_stopless_1'
          }
        },
        pipelineMetadata: {
          capturedChatRequest: {
            model: 'qwen3.6-plus',
            messages: [{ role: 'user', content: '<**stopless:on**> hi' }]
          }
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockSyncReasoningStopModeFromRequest).toHaveBeenCalledTimes(1);
    const syncArgs = mockSyncReasoningStopModeFromRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(syncArgs?.sessionId).toBe('sess_stopless_1');
    expect(syncArgs?.conversationId).toBe('conv_stopless_1');
    expect(mockSyncReasoningStopModeFromRequest.mock.calls[0]?.[1]).toBe('on');

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.context?.sessionId).toBe('sess_stopless_1');
    expect(bridgeArgs?.context?.conversationId).toBe('conv_stopless_1');
  });
});
