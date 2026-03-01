import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn(async () => ({ body: { id: 'mock' } }));
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder
});
const mockInjectClockClientPromptWithResult = jest.fn(async () => ({ ok: true }));
const mockUnbindSessionScope = jest.fn();
const mockGetClockClientRegistry = jest.fn(() => ({
  unbindSessionScope: mockUnbindSessionScope
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
  it('maps SSE context-length overflow into CONTEXT_LENGTH_EXCEEDED', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'anthropic-messages',
          requestId: 'req_ctx_overflow',
          wantsStream: true,
          response: {
            body: {
              mode: 'sse',
              error:
                "Anthropic SSE error event [1210] API 调用参数有误。Request 222313 input tokens exceeds the model's maximum context length 202752"
            }
          } as any,
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

  it('does not short-circuit passthrough responses when servertools stay enabled', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_passthrough_servertool_on',
        processMode: 'passthrough',
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
  });

  it('still short-circuits passthrough responses when servertools are disabled explicitly', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_passthrough_servertool_off',
        processMode: 'passthrough',
        serverToolsEnabled: false,
        wantsStream: false,
        response: { body: { id: 'upstream_passthrough' } } as any,
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

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();
    expect((converted as any).body).toEqual({ id: 'upstream_passthrough' });
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

  it('routes clientInjectOnly followup through clientInjectDispatch without executeNested', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockClear();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      const dispatchResult = await clientInjectDispatch({
        entryEndpoint: '/v1/responses',
        requestId: 'followup_req_client_inject',
        body: {
          messages: [{ role: 'assistant', content: 'noop' }]
        },
        metadata: {
          __rt: { serverToolFollowup: true },
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientTmuxSessionId: 'rcc_client_inject_1',
          tmuxSessionId: 'rcc_client_inject_1'
        }
      });
      return { body: { mode: dispatchResult.ok ? 'client_inject_only' : 'failed' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_client_inject_only',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect((converted as any).body).toEqual({ mode: 'client_inject_only' });
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'rcc_client_inject_1',
        text: '继续执行'
      })
    );
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
    mockUnbindSessionScope.mockReset();

    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_inject_fail',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          clockDaemonId: 'daemon_stale',
          tmuxSessionId: 'tmux_sess_stale',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.continue_execution'
        }
      });
      return { body: { id: 'upstream_body' } };
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
    ).resolves.toMatchObject({
      body: { id: 'upstream_body' }
    });

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_sess_stale'
      })
    );
    expect(mockGetClockClientRegistry).toHaveBeenCalled();
    expect(mockUnbindSessionScope).toHaveBeenCalledWith('tmux:tmux_sess_stale');
  });

  it('fails fast when session has no bound tmux and does not execute nested followup', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_inject_unbound',
        body: null as any,
        metadata: {
          __rt: { serverToolFollowup: true },
          clockDaemonId: 'daemon_unbound',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.stop_message'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'anthropic-messages',
          requestId: 'req_inject_unbound_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata: {}
        },
        {
          runtimeManager: {
            resolveRuntimeKey: () => undefined,
            getHandleByRuntimeKey: () => undefined
          },
          executeNested
        }
      )
    ).resolves.toMatchObject({
      body: { id: 'upstream_body' }
    });

    expect(mockInjectClockClientPromptWithResult).not.toHaveBeenCalled();
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockUnbindSessionScope).not.toHaveBeenCalled();
  });

  it('rejects session-only client inject followup when conversation has no tmux binding', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_session_only',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionId: 'sess_only',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.stop_message'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'anthropic-messages',
          requestId: 'req_session_only_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata: {}
        },
        {
          runtimeManager: {
            resolveRuntimeKey: () => undefined,
            getHandleByRuntimeKey: () => undefined
          },
          executeNested
        }
      )
    ).resolves.toMatchObject({
      body: { id: 'upstream_body' }
    });

    expect(mockInjectClockClientPromptWithResult).not.toHaveBeenCalled();
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockUnbindSessionScope).not.toHaveBeenCalled();
  });

  it('uses clock daemon binding key for strict client injection target', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockInjectClockClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_clockd_binding',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionId: 'sess_original',
          conversationId: 'conv_original',
          clockDaemonId: 'daemon_138',
          tmuxSessionId: 'tmux_daemon_138',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.stop_message'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_clockd_binding_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_daemon_138',
        text: '继续执行'
      })
    );
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('injects continue_execution via tmux only and skips reenter execution', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockInjectClockClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_continue_only',
        body: {
          messages: [{ role: 'assistant', content: 'ack' }]
        },
        metadata: {
          __rt: { serverToolFollowup: true },
          clockDaemonId: 'daemon_continue_1',
          tmuxSessionId: 'tmux_continue_1',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.continue_execution'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_continue_only_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_continue_1',
        text: '继续执行',
        source: 'servertool.continue_execution'
      })
    );
    const injectArgs = mockInjectClockClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('injects clock directive via tmux only and skips reenter execution', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockInjectClockClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    const clockDirective = '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run"}**>';
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_clock_only',
        body: {
          messages: [{ role: 'assistant', content: 'ack' }]
        },
        metadata: {
          __rt: { serverToolFollowup: true },
          clockDaemonId: 'daemon_clock_1',
          tmuxSessionId: 'tmux_clock_1',
          clientInjectOnly: true,
          clientInjectText: clockDirective,
          clientInjectSource: 'servertool.clock'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_clock_only_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_clock_1',
        text: clockDirective,
        source: 'servertool.clock'
      })
    );
    const injectArgs = mockInjectClockClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('does not pass legacy sessionId when explicit tmuxSessionId is provided', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectClockClientPromptWithResult.mockReset();
    mockInjectClockClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetClockClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_tmux_explicit',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          tmuxSessionId: 'tmux_explicit_1',
          sessionId: 'legacy_session_should_not_pass',
          clientInjectOnly: true,
          clientInjectText: '继续执行',
          clientInjectSource: 'servertool.stop_message'
        }
      });
      return { body: { id: 'upstream_body' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_tmux_explicit_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested
      }
    );

    expect(mockInjectClockClientPromptWithResult).toHaveBeenCalledTimes(1);
    const injectArgs = mockInjectClockClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.tmuxSessionId).toBe('tmux_explicit_1');
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });
});
