import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';

const mockConvertProviderResponse = jest.fn(async () => ({ body: { id: 'mock' } }));
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => {
    const text = typeof raw === 'string' ? raw : '';
    return text
      .replace(/<\*\*[\s\S]*?\*\*>/g, ' ')
      .replace(/\[Time\/Date\]:.*?(?=(?:\\n|\n|$))/g, ' ')
      .replace(/\[Image omitted\]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
});
const mockInjectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true }));
const mockUnbindSessionScope = jest.fn();
const mockGetSessionClientRegistry = jest.fn(() => ({
  unbindSessionScope: mockUnbindSessionScope
}));
const mockSessionRegistryModule = () => ({
  injectSessionClientPromptWithResult: mockInjectSessionClientPromptWithResult,
  getSessionClientRegistry: mockGetSessionClientRegistry
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/server/runtime/http-server/session-client-registry.js', mockSessionRegistryModule);
jest.unstable_mockModule('../../../../../src/server/runtime/http-server/session-client-registry.ts', mockSessionRegistryModule);

describe('provider-response-converter servertool regressions', () => {
  it('maps SSE context-length overflow into CONTEXT_LENGTH_EXCEEDED', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();

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

  it('maps retryable anthropic SSE network failures into HTTP_502', async () => {
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
          requestId: 'req_sse_network_failure',
          wantsStream: true,
          response: {
            body: {
              mode: 'sse',
              error: {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'Internal Network Failure'
                }
              }
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
      code: 'HTTP_502',
      status: 502,
      statusCode: 502,
      retryable: true
    });
  });

  it('remaps bridge SSE decode network failures into HTTP_502', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockClear();
    mockCreateSnapshotRecorder.mockClear();
    mockConvertProviderResponse.mockImplementationOnce(async () => {
      const error = new Error(
        '[chat_process.resp.stage1.sse_decode] Failed to decode SSE payload for protocol anthropic-messages: Anthropic SSE error event Internal Network Failure'
      ) as Error & {
        code?: string;
        name?: string;
        details?: Record<string, unknown>;
      };
      error.name = 'ProviderProtocolError';
      error.code = 'SSE_DECODE_ERROR';
      error.details = {
        upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED'
      };
      throw error;
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/messages',
          providerProtocol: 'anthropic-messages',
          requestId: 'req_bridge_sse_network_failure',
          wantsStream: true,
          response: {
            body: {
              id: 'mock'
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
      code: 'HTTP_502',
      status: 502,
      statusCode: 502,
      retryable: true
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
    mockInjectSessionClientPromptWithResult.mockClear();

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
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'rcc_client_inject_1',
        text: '继续执行'
      })
    );
  });

  it('sanitizes polluted stop_message client inject text on host followup path', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({ ok: true });

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      const dispatchResult = await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_stopmessage_sanitize_host',
        body: {
          messages: [
            {
              role: 'assistant',
              content:
                '<**stopMessage:"继续推进",3**>\n[Time/Date]: utc=`2026-03-10T11:24:09.352Z` local=`2026-03-10 19:24:09.352 +08:00` tz=`Asia/Shanghai` nowMs=`1773141849352` ntpOffsetMs=`40`\n[Image omitted]\n当前先继续实现。'
            }
          ]
        },
        metadata: {
          __rt: { serverToolFollowup: true },
          clientInjectOnly: true,
          clientInjectSource: 'servertool.stop_message',
          clientInjectText:
            '<**stopMessage:"继续推进",3**>\n[Time/Date]: utc=`2026-03-10T11:24:09.352Z` local=`2026-03-10 19:24:09.352 +08:00` tz=`Asia/Shanghai` nowMs=`1773141849352` ntpOffsetMs=`40`\n[Image omitted]\n继续推进任务，并先补测试。',
          stopMessageClientInjectSessionScope: 'tmux:rcc_client_inject_sanitize_1',
          clientTmuxSessionId: 'rcc_client_inject_sanitize_1',
          tmuxSessionId: 'rcc_client_inject_sanitize_1'
        }
      });
      return { body: { mode: dispatchResult.ok ? 'client_inject_only' : 'failed' } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_client_inject_sanitize_host',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        originalRequest: {
          model: 'gpt-test',
          messages: [
            {
              role: 'user',
              content:
                '<**stopMessage:"继续推进",3**>\n[Time/Date]: utc=`2026-03-10T11:24:09.352Z` local=`2026-03-10 19:24:09.352 +08:00` tz=`Asia/Shanghai` nowMs=`1773141849352` ntpOffsetMs=`40`\n[Image omitted]\n请继续推进任务'
            }
          ]
        },
        pipelineMetadata: {
          tmuxSessionId: 'rcc_client_inject_sanitize_1',
          clientTmuxSessionId: 'rcc_client_inject_sanitize_1'
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

    expect((converted as any).body).toEqual({ mode: 'client_inject_only' });
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    const injectArgs = mockInjectSessionClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.tmuxSessionId).toBe('rcc_client_inject_sanitize_1');
    expect(String(injectArgs.text || '')).toContain('继续推进任务，并先补测试。');
    expect(String(injectArgs.text || '')).not.toContain('<**stopMessage');
    expect(String(injectArgs.text || '')).not.toContain('[Time/Date]:');
    expect(String(injectArgs.text || '')).not.toContain('[Image omitted]');
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

  it('maps malformed anthropic model_context_window_exceeded bridge errors to explicit 400 error', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('Anthropic upstream returned stop_reason=model_context_window_exceeded with empty assistant output'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE',
          details: {
            reason: 'model_context_window_exceeded'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          requestId: 'req_model_ctx_window_1',
          wantsStream: true,
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

  it('remaps qwenchat malformed bridge errors with hidden native tool raw payload to explicit 502', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_hidden_native_tool_1',
          wantsStream: false,
          response: {
            body: {
              raw: [
                'data: {"choices":[{"delta":{"role":"assistant","phase":"web_extractor","function_call":{"name":"web_extractor","arguments":"{\\"goal\\":\\"read file\\"}"}}}]}',
                ''
              ].join('\n')
            }
          } as any,
          originalRequest: {
            model: 'qwen3.6-plus',
            metadata: { sessionId: 'sess_qwen_hidden_tool' }
          },
          requestSemantics: {
            tools: {
              clientToolsRaw: [
                {
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    parameters: {
                      type: 'object',
                      properties: { cmd: { type: 'string' } }
                    }
                  }
                }
              ]
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
      code: 'QWENCHAT_HIDDEN_NATIVE_TOOL',
      status: 502,
      statusCode: 502,
      toolName: 'web_extractor',
      phase: 'web_extractor'
    });
  });

  it('remaps qwenchat malformed bridge errors with business rejection payload to explicit completion rejection', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_business_reject_1',
          wantsStream: false,
          response: {
            body: {
              success: false,
              request_id: 'req_upstream_qwen',
              data: {
                code: 'Unauthorized',
                details: '您没有权限访问此资源。请联系您的管理员以获取帮助。'
              }
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
      code: 'QWENCHAT_COMPLETION_REJECTED',
      status: 403,
      statusCode: 403
    });
  });

  it('remaps qwenchat malformed bridge errors with known hidden native tool even when declared tool allowlist is unavailable', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_hidden_native_tool_no_allowlist_1',
          wantsStream: false,
          response: {
            body: {
              body: {
                raw: [
                  'data: {"choices":[{"delta":{"role":"assistant","phase":"web_extractor","function_call":{"name":"web_extractor","arguments":"{\\"goal\\":\\"read file\\"}"}}}]}',
                  ''
                ].join('\n')
              }
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
      code: 'QWENCHAT_HIDDEN_NATIVE_TOOL',
      status: 502,
      statusCode: 502,
      toolName: 'web_extractor',
      phase: 'web_extractor'
    });
  });

  it('remaps qwenchat malformed bridge errors from mode=sse raw wrapper with known hidden native tool', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_hidden_native_tool_mode_sse_1',
          wantsStream: false,
          response: {
            body: {
              mode: 'sse',
              raw: [
                'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"web_search","status":"typing","function_call":{"name":"web_search","arguments":"{\\"queries\\":[\\"RouteCodex Bot finger-300\\"]}"},"function_id":"round_0_1"}}]}',
                'data: [DONE]'
              ].join('\n')
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
      code: 'QWENCHAT_HIDDEN_NATIVE_TOOL',
      status: 502,
      statusCode: 502,
      toolName: 'web_search',
      phase: 'web_search'
    });
  });

  it('remaps qwenchat malformed bridge errors from __sse_responses terminal hidden-native-tool metadata', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
        }
      );
      throw err;
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const sseStream = new PassThrough();
    Object.assign(sseStream as Record<string, unknown>, {
      __routecodexTerminalError: {
        message: 'QwenChat upstream emitted undeclared native tool \"web_extractor\" (phase=web_extractor)',
        code: 'QWENCHAT_HIDDEN_NATIVE_TOOL',
        status: 502,
        statusCode: 502,
        retryable: false,
        toolName: 'web_extractor',
        phase: 'web_extractor'
      }
    });

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_hidden_native_tool_sse_stream_meta_1',
          wantsStream: false,
          response: {
            body: {
              __sse_responses: sseStream
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
      code: 'QWENCHAT_HIDDEN_NATIVE_TOOL',
      status: 502,
      statusCode: 502,
      toolName: 'web_extractor',
      phase: 'web_extractor'
    });
  });

  it('recovers qwenchat malformed bridge errors from partial RCC dry-run JSON when tool name and cmd are still recoverable', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse
      .mockImplementationOnce(async () => {
        const err = Object.assign(
          new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
          {
            name: 'ProviderProtocolError',
            code: 'MALFORMED_RESPONSE'
          }
        );
        throw err;
      })
      .mockImplementationOnce(async ({ providerResponse }: { providerResponse: Record<string, unknown> }) => ({
        body: providerResponse
      }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_qwen_partial_recover_1',
        wantsStream: false,
        response: {
          body: {
            raw: [
              'data: {"choices":[{"delta":{"role":"assistant","content":"<<RCC_TOOL_CALLS_JSON\\n{\\"tool_calls\\":[{\\"name\\":\\"exec_command\\",\\"input\\":{\\"cmd\\":\\"pwd\\"}}]","phase":"answer","status":"typing"}}]}',
              'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}]}',
              ''
            ].join('\n')
          }
        } as any,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: { cmd: { type: 'string' } }
                  }
                }
              }
            ]
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
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(2);
    expect(result.body).toMatchObject({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'pwd' })
                }
              }
            ]
          }
        }
      ]
    });
  });

  it('rejects qwenchat partial RCC recovery when recovered args violate canonical client schema', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_partial_invalid_args_1',
          wantsStream: false,
          response: {
            body: {
              raw: [
                'data: {"choices":[{"delta":{"role":"assistant","content":"<<RCC_TOOL_CALLS_JSON\\n{\\"tool_calls\\":[{\\"name\\":\\"exec_command\\",\\"input\\":{\\"command\\":\\"pwd\\"}}]","phase":"answer","status":"typing"}}]}',
                'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}]}',
                ''
              ].join('\n')
            }
          } as any,
          requestSemantics: {
            tools: {
              clientToolsRaw: [
                {
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    parameters: {
                      type: 'object',
                      properties: { cmd: { type: 'string' } }
                    }
                  }
                }
              ]
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
      code: 'QWENCHAT_INVALID_TOOL_ARGS',
      status: 502,
      statusCode: 502,
      toolName: 'exec_command',
      validationReason: 'missing_cmd',
      validationMessage: 'exec_command requires input.cmd as a non-empty string.',
      missingFields: ['cmd']
    });
  });

  it('rejects converted provider responses whose tool args only pass via alias guessing', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'chatcmpl-invalid-tool-args',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_invalid_exec',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: JSON.stringify({ command: 'pwd' })
                  }
                }
              ]
            }
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_converted_invalid_tool_args_1',
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
      code: 'CLIENT_TOOL_ARGS_INVALID',
      status: 502,
      statusCode: 502,
      toolName: 'exec_command',
      validationReason: 'missing_cmd',
      validationMessage: 'exec_command requires input.cmd as a non-empty string.',
      missingFields: ['cmd']
    });
  });

  it('rejects converted reasoning.stop calls with explicit missing field guidance', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'chatcmpl-invalid-reasoning-stop-args',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_invalid_reasoning_stop',
                  type: 'function',
                  function: {
                    name: 'reasoning.stop',
                    arguments: JSON.stringify({ is_completed: true })
                  }
                }
              ]
            }
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_invalid_reasoning_stop_args_1',
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
      code: 'CLIENT_TOOL_ARGS_INVALID',
      status: 502,
      statusCode: 502,
      toolName: 'reasoning.stop',
      validationReason: 'invalid_reasoning_stop_arguments',
      validationMessage: 'reasoning.stop requires task_goal.',
      missingFields: ['task_goal']
    });
  });

  it('remaps qwenchat malformed bridge errors with incomplete RCC opener only to explicit retryable tool dryrun error', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_incomplete_opener_1',
          wantsStream: false,
          response: {
            body: {
              raw: [
                'data: {"choices":[{"delta":{"role":"assistant","content":"<<RCC_TOOL_CALLS_JSON","phase":"answer","status":"typing"}}]}',
                'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}]}',
                ''
              ].join('\n')
            }
          } as any,
          requestSemantics: {
            tools: {
              clientToolsRaw: [
                {
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    parameters: {
                      type: 'object',
                      properties: { cmd: { type: 'string' } }
                    }
                  }
                }
              ]
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
      code: 'QWENCHAT_INCOMPLETE_TOOL_DRYRUN',
      status: 502,
      statusCode: 502,
      retryable: true
    });
  });

  it('remaps qwenchat malformed bridge errors to business rejection when unauthorized json is nested inside raw carrier', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const err = Object.assign(
        new Error('[hub_response] Failed to canonicalize response payload at chat_process.response.entry'),
        {
          name: 'ProviderProtocolError',
          code: 'MALFORMED_RESPONSE'
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
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_qwen_nested_business_reject_1',
          wantsStream: false,
          response: {
            body: {
              meta: { mode: 'sse' },
              body: {
                raw: JSON.stringify({
                  success: false,
                  request_id: 'req_upstream_qwen_nested',
                  data: {
                    code: 'Unauthorized',
                    details: '您没有权限访问此资源。请联系您的管理员以获取帮助。'
                  }
                })
              }
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
      code: 'QWENCHAT_COMPLETION_REJECTED',
      status: 403,
      statusCode: 403
    });
  });

  it('fails followup when client inject cannot resolve tmux binding and unbinds stale session', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({
      ok: false,
      reason: 'no_matching_tmux_session_daemon'
    });
    mockGetSessionClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_inject_fail',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionDaemonId: 'daemon_stale',
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

    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_sess_stale'
      })
    );
    expect(mockGetSessionClientRegistry).toHaveBeenCalled();
    expect(mockUnbindSessionScope).toHaveBeenCalledWith('tmux:tmux_sess_stale');
  });

  it('fails fast when session has no bound tmux and does not execute nested followup', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockGetSessionClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_inject_unbound',
        body: null as any,
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionDaemonId: 'daemon_unbound',
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

    expect(mockInjectSessionClientPromptWithResult).not.toHaveBeenCalled();
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockUnbindSessionScope).not.toHaveBeenCalled();
  });

  it('rejects session-only client inject followup when conversation has no tmux binding', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockGetSessionClientRegistry.mockClear();
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

    expect(mockInjectSessionClientPromptWithResult).not.toHaveBeenCalled();
    expect(executeNested).not.toHaveBeenCalled();
    expect(mockUnbindSessionScope).not.toHaveBeenCalled();
  });

  it('uses session daemon binding key for strict client injection target', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetSessionClientRegistry.mockClear();
    mockUnbindSessionScope.mockReset();

    const executeNested = jest.fn(async () => ({ body: { ok: true } }));
    mockConvertProviderResponse.mockImplementation(async ({ clientInjectDispatch }) => {
      await clientInjectDispatch({
        entryEndpoint: '/v1/messages',
        requestId: 'followup_req_sessiond_binding',
        body: { messages: [{ role: 'assistant', content: 'ack' }] },
        metadata: {
          __rt: { serverToolFollowup: true },
          sessionId: 'sess_original',
          conversationId: 'conv_original',
          sessionDaemonId: 'daemon_138',
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
        requestId: 'req_sessiond_binding_1',
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

    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledWith(
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
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetSessionClientRegistry.mockClear();
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
          sessionDaemonId: 'daemon_continue_1',
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

    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_continue_1',
        text: '继续执行',
        source: 'servertool.continue_execution'
      })
    );
    const injectArgs = mockInjectSessionClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('injects clock directive via tmux only and skips reenter execution', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetSessionClientRegistry.mockClear();
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
          sessionDaemonId: 'daemon_session_1',
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

    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tmuxSessionId: 'tmux_clock_1',
        text: clockDirective,
        source: 'servertool.clock'
      })
    );
    const injectArgs = mockInjectSessionClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('does not pass legacy sessionId when explicit tmuxSessionId is provided', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockInjectSessionClientPromptWithResult.mockReset();
    mockInjectSessionClientPromptWithResult.mockResolvedValue({ ok: true });
    mockGetSessionClientRegistry.mockClear();
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

    expect(mockInjectSessionClientPromptWithResult).toHaveBeenCalledTimes(1);
    const injectArgs = mockInjectSessionClientPromptWithResult.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(injectArgs.tmuxSessionId).toBe('tmux_explicit_1');
    expect(injectArgs.sessionId).toBeUndefined();
    expect(executeNested).not.toHaveBeenCalled();
  });
});
