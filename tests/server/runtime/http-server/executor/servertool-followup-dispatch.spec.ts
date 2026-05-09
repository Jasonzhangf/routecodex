import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockRunClientInjectionFlowBeforeReenter = jest.fn();

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/client-injection-flow.js',
  () => ({
    runClientInjectionFlowBeforeReenter: mockRunClientInjectionFlowBeforeReenter
  })
);

describe('servertool followup dispatch helper', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRunClientInjectionFlowBeforeReenter.mockReset();
  });

  it('reenter path reuses normalized nested metadata and executes nested request once', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({ status: 200, body: { echoed: input.metadata } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/messages',
      fallbackEntryEndpoint: '/v1/messages',
      requestId: 'req_followup_dispatch_1',
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'anthropic-session-id': 'sess_1',
          'anthropic-conversation-id': 'conv_1',
          authorization: 'Bearer should-not-forward'
        },
        clientRequestId: 'client_req_1'
      },
      baseMetadata: {
        someBase: 'value'
      },
      executeNested
    });

    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    expect(executeNested).toHaveBeenCalledTimes(1);

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata).toMatchObject({
      someBase: 'value',
      sessionId: 'sess_1',
      conversationId: 'conv_1',
      clientHeaders: {
        'anthropic-session-id': 'sess_1',
        'anthropic-conversation-id': 'conv_1'
      }
    });
    expect(nestedInput?.headers).toEqual({
      'anthropic-session-id': 'sess_1',
      'anthropic-conversation-id': 'conv_1',
      authorization: 'Bearer should-not-forward'
    });
    expect(nestedInput?.metadata?.clientRequestId).toBeUndefined();
    expect((result.body as Record<string, any>)?.echoed?.sessionId).toBe('sess_1');
  });

  it('reenter path short-circuits to client inject only outcome before nested execute', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: true });
    const executeNested = jest.fn(async () => ({ status: 200, body: { unexpected: true } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_2',
      body: { input: 'continue' },
      metadata: {
        clientInjectOnly: true,
        clientInjectText: '继续执行'
      },
      executeNested
    });

    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    expect(executeNested).not.toHaveBeenCalled();
    expect(result).toEqual({
      body: { ok: true, mode: 'client_inject_only' }
    });
  });

  it('client inject dispatch uses the same normalized metadata builder', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: true });

    const { executeServerToolClientInjectDispatch } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolClientInjectDispatch({
      entryEndpoint: '/v1/messages',
      fallbackEntryEndpoint: '/v1/messages',
      requestId: 'req_followup_dispatch_3',
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'x-routecodex-session-daemon-id': 'daemon_1',
          'x-routecodex-client-tmux-session-id': 'tmux_1'
        }
      }
    });

    expect(result).toEqual({ ok: true });
    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    const injectArgs = mockRunClientInjectionFlowBeforeReenter.mock.calls[0]?.[0] as Record<string, any>;
    expect(injectArgs?.nestedMetadata?.clientDaemonId).toBe('daemon_1');
    expect(injectArgs?.nestedMetadata?.clientTmuxSessionId).toBe('tmux_1');
  });

  it('reenter path preserves full client headers for normal request metadata rebuild', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({ status: 200, body: { headers: input.headers } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_4',
      body: { input: 'continue' },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          'user-agent': 'Codex/1.0',
          authorization: 'Bearer test-token',
          'anthropic-session-id': 'sess_1'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.headers).toEqual({
      'user-agent': 'Codex/1.0',
      authorization: 'Bearer test-token',
      'anthropic-session-id': 'sess_1'
    });
    expect((result.body as Record<string, any>)?.headers?.authorization).toBe('Bearer test-token');
  });

  it('reenter path injects original request semantics into nested body when followup body lost them', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        semantics: input.body?.semantics,
        tools: input.body?.semantics?.tools?.clientToolsRaw
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ]
      }
    };

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_4b',
      body: {
        model: 'mimo-v2.5-pro',
        input: 'continue',
        tools: [{ type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }]
      },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_continue'
        }
      },
      requestSemantics,
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.tools?.map((tool: any) => tool?.function?.name)).toEqual([
      'exec_command',
      'reasoning.stop'
    ]);
    expect((nestedInput?.body?.semantics as any)?.__routecodex).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.reasoning_stop_continue'
    });
    expect((nestedInput?.body?.semantics as any)?.tools?.clientToolsRaw?.[0]?.function?.name).toBe('exec_command');
    expect((nestedInput?.metadata?.requestSemantics as any)?.__routecodex).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.reasoning_stop_continue'
    });
    expect(((result.body as Record<string, any>)?.tools ?? [])[0]?.function?.name).toBe('exec_command');
  });

  it('reenter path strips stale responses output budget from servertool followup semantics', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        semantics: input.body?.semantics,
        requestSemantics: input.metadata?.requestSemantics
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const requestSemantics = {
      responses: {
        requestParameters: {
          model: 'deepseek-v4-pro',
          max_tokens: 384000,
          max_output_tokens: 384000,
          reasoning: { effort: 'high' }
        }
      },
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ]
      }
    };

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_strip_stale_budget',
      body: {
        model: 'mimo-v2.5-pro',
        max_tokens: 384000,
        max_output_tokens: 384000,
        input: 'continue',
        tools: [{ type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }]
      },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_guard'
        }
      },
      requestSemantics,
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.max_tokens).toBeUndefined();
    expect(nestedInput?.body?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.reasoning).toEqual({ effort: 'high' });
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.max_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.model).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.__routecodex).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.reasoning_stop_guard'
    });
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.max_tokens).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.__routecodex).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.reasoning_stop_guard'
    });
  });

  it('reenter path overwrites stale metadata requestSemantics with materialized followup semantics', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        semantics: input.body?.semantics,
        requestSemantics: input.metadata?.requestSemantics
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const requestSemantics = {
      responses: {
        requestParameters: {
          model: 'deepseek-v4-pro',
          max_tokens: 384000,
          max_output_tokens: 384000,
          reasoning: { effort: 'high' }
        }
      },
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          },
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              parameters: { type: 'object', properties: { patch: { type: 'string' } } }
            }
          }
        ]
      }
    };

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_overwrite_stale_metadata_semantics',
      body: {
        model: 'mimo-v2.5-pro',
        max_tokens: 384000,
        max_output_tokens: 384000,
        input: 'continue',
        tools: [{ type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }]
      },
      metadata: {
        requestSemantics: {
          responses: {
            requestParameters: {
              model: 'stale-model',
              max_tokens: 384000,
              max_output_tokens: 384000
            }
          },
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: { name: 'reasoning.stop', parameters: { type: 'object' } }
              }
            ]
          }
        },
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_guard'
        }
      },
      requestSemantics,
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.tools?.map((tool: any) => tool?.function?.name)).toEqual([
      'exec_command',
      'apply_patch',
      'reasoning.stop'
    ]);
    expect(nestedInput?.body?.max_tokens).toBeUndefined();
    expect(nestedInput?.body?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.reasoning).toEqual({ effort: 'high' });
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.max_tokens).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.model).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.tools?.clientToolsRaw?.map((tool: any) => tool?.function?.name)).toEqual([
      'exec_command',
      'apply_patch'
    ]);
    expect((nestedInput?.metadata?.requestSemantics as any)?.__routecodex).toEqual({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.reasoning_stop_guard'
    });
  });

  it('reenter path throws when nested pipeline returns HTTP error body instead of success payload', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async () => ({
      status: 502,
      body: {
        error: {
          message: 'Converted provider tool call has invalid client arguments',
          code: 'CLIENT_TOOL_ARGS_INVALID',
          request_id: 'nested_req_1'
        }
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await expect(executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_5',
      body: { input: 'continue' },
      executeNested
    })).rejects.toMatchObject({
      message: 'Converted provider tool call has invalid client arguments',
      code: 'CLIENT_TOOL_ARGS_INVALID',
      upstreamCode: 'CLIENT_TOOL_ARGS_INVALID',
      status: 502,
      requestExecutorProviderErrorStage: 'provider.followup'
    });
  });


  it('reenter path fails fast when nested execute never resolves', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(
      async () => await new Promise(() => {
        // never resolve
      })
    );

    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = '20';
    try {
      const { executeServerToolReenterPipeline } = await import(
        '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
      );

      await expect(executeServerToolReenterPipeline({
        entryEndpoint: '/v1/responses',
        fallbackEntryEndpoint: '/v1/responses',
        requestId: 'req_followup_dispatch_timeout',
        body: { input: 'continue' },
        executeNested
      })).rejects.toMatchObject({
        code: 'SERVERTOOL_TIMEOUT',
        upstreamCode: 'servertool_followup_timeout',
        status: 504,
        requestExecutorProviderErrorStage: 'provider.followup'
      });
    } finally {
      delete process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
    }
  });

  it('reenter path throws when nested pipeline returns HTTP status without explicit error object', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async () => ({
      status: 504,
      body: { detail: 'gateway timeout' }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await expect(executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_6',
      body: { input: 'continue' },
      executeNested
    })).rejects.toMatchObject({
      message: 'ServerTool nested followup request failed with HTTP 504',
      code: 'HTTP_504',
      upstreamCode: 'HTTP_504',
      status: 504,
      requestExecutorProviderErrorStage: 'provider.followup'
    });
  });
});
