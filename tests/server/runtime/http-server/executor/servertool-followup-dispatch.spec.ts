import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockRunClientInjectionFlowBeforeReenter = jest.fn();
const mockGetDefaultServertoolSkeletonDocumentWithNative = jest.fn();
const mockCaptureResponsesRequestContext = jest.fn();
const mockRebindResponsesConversationRequestId = jest.fn();

jest.unstable_mockModule(
  '../../../../../src/server/runtime/http-server/executor/client-injection-flow.js',
  () => ({
    runClientInjectionFlowBeforeReenter: mockRunClientInjectionFlowBeforeReenter
  })
);

jest.unstable_mockModule(
  '../../../../../src/modules/llmswitch/bridge/module-loader.js',
  () => ({
    importCoreDist: jest.fn(async (subpath: string) => {
      if (subpath === 'conversion/shared/responses-conversation-store') {
        return {
          captureResponsesRequestContext: mockCaptureResponsesRequestContext,
          rebindResponsesConversationRequestId: mockRebindResponsesConversationRequestId
        };
      }
      if (subpath === 'router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers') {
        return {
          normalizeServertoolFollowupPayloadShapeWithNative: (_entryEndpoint: string, payload: Record<string, unknown>) => {
            const messages = Array.isArray(payload.messages) ? payload.messages as any[] : undefined;
            if (!messages) {
              return payload;
            }
            const semanticsRecord =
              payload.semantics && typeof payload.semantics === 'object' && !Array.isArray(payload.semantics)
                ? payload.semantics as Record<string, any>
                : {};
            const semanticToolChoice = semanticsRecord.responses?.requestParameters?.tool_choice;
            const input = messages.map((message) => {
              if (message?.role === 'tool') {
                return {
                  type: 'function_call_output',
                  call_id: message.tool_call_id,
                  output: message.content
                };
              }
              return message;
            });
            const toolOutputs = input.filter((entry) => entry?.type === 'function_call_output');
            const semantics = {
              ...semanticsRecord,
              toolOutputs
            };
            return {
              ...payload,
              ...(payload.tool_choice === undefined && semanticToolChoice !== undefined
                ? { tool_choice: semanticToolChoice }
                : {}),
              messages: undefined,
              input,
              semantics
            };
          }
        };
      }
      throw new Error(`unexpected importCoreDist ${subpath}`);
    })
  })
);

jest.unstable_mockModule(
  '../../../../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    getDefaultServertoolSkeletonDocumentWithNative: mockGetDefaultServertoolSkeletonDocumentWithNative,
    detectEmptyAssistantPayloadContractSignalWithNative: jest.fn(() => false),
    planServertoolToolCallDispatchWithNative: jest.fn(() => ({
      executableServerToolCalls: [],
      deferredClientToolCalls: [],
      skippedToolCalls: []
    })),
    runServertoolResponseStageWithNative: jest.fn((payload: any) => ({
      normalizedPayload: payload,
      toolCalls: []
    })),
    planStopMessagePersistedLookupWithNative: jest.fn(() => ({
      shouldLoad: false
    })),
    resolveStopMessageSessionScopeWithNative: jest.fn(() => null),
    resolveServertoolStateKeyWithNative: jest.fn(() => null),
    resolveServertoolStickyKeyWithNative: jest.fn(() => null),
    planServertoolOutcomeWithNative: jest.fn(() => ({
      mode: 'passthrough'
    })),
    planServertoolAutoHookQueuesWithNative: jest.fn(() => ({
      optionalPrimaryOrder: [],
      mandatoryOrder: []
    })),
    planServertoolFollowupRuntimeWithNative: jest.fn(() => null)
  })
);

describe('servertool followup dispatch helper', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRunClientInjectionFlowBeforeReenter.mockReset();
    mockGetDefaultServertoolSkeletonDocumentWithNative.mockReset();
    mockCaptureResponsesRequestContext.mockReset();
    mockRebindResponsesConversationRequestId.mockReset();
    mockGetDefaultServertoolSkeletonDocumentWithNative.mockReturnValue({
      version: 1,
      servertool: {
        enabled: true,
        internalTools: {
          clock: {
            name: 'clock',
            enabled: true,
            kind: 'internal',
            trigger: { type: 'tool_call', canonicalName: 'clock' },
            execution: { mode: 'guarded', stripAfterExecute: true }
          },
          exec_command: {
            name: 'exec_command',
            enabled: true,
            kind: 'internal',
            trigger: { type: 'tool_call', canonicalName: 'exec_command' },
            execution: { mode: 'guarded', stripAfterExecute: true }
          },
          apply_patch: {
            name: 'apply_patch',
            enabled: true,
            kind: 'internal',
            trigger: { type: 'tool_call', canonicalName: 'apply_patch' },
            execution: { mode: 'reenter', stripAfterExecute: true }
          }
        },
        skeleton: {
          requestPrepare: { enabled: true },
          internalDispatch: { enabled: true },
          finalizeStrip: { enabled: true },
          autoHooks: { optionalPrimaryOrder: [], mandatoryOrder: [] },
          pendingInjection: { messageKinds: [] },
          progress: { toolNameByFlowId: {}, goldHighlightFlowIds: [] },
          followup: {
            genericInjectionOps: [],
            nativeSupportedOps: [],
            flowPolicy: {
              profilesByFlowId: {
                stop_message_flow: {
                  seedLoopPayload: true,
                  retryEmptyFollowupOnce: true,
                  stopMessageFollowupPolicy: 'preserve_eligibility'
                }
              }
            }
          }
        },
        state: {
          scopePriority: [],
          pendingInjection: { enabled: true, strictContract: true }
        }
      }
    });
  });

  it('servertool skeleton declares apply_patch as the unified internal reenter servertool', async () => {
    const { getServertoolToolSpec } = await import(
      '../../../../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js'
    );
    expect(getServertoolToolSpec('apply_patch')).toMatchObject({
      name: 'apply_patch',
      trigger: { type: 'tool_call', canonicalName: 'apply_patch' },
      execution: { mode: 'reenter', stripAfterExecute: true }
    });
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

  it.each([
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'continue' }] }],
    ['/v1/messages', { messages: [{ role: 'user', content: 'continue' }] }],
    ['/v1/responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }] }]
  ])('servertool reenter uses the HTTP server nested entry for %s', async (entryEndpoint, body) => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        entryEndpoint: input.entryEndpoint,
        stage: input.metadata?.stage,
        direction: input.metadata?.direction,
        followup: input.metadata?.__rt?.serverToolFollowup
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint,
      fallbackEntryEndpoint: '/v1/chat/completions',
      requestId: `req_followup_dispatch_entry_${entryEndpoint.replace(/[^a-z0-9]+/gi, '_')}`,
      body: body as Record<string, unknown>,
      metadata: {
        __rt: { serverToolFollowup: true }
      },
      baseMetadata: {
        routecodexLocalPort: 5555,
        routecodexPortMode: 'router'
      },
      executeNested
    });

    expect(mockRunClientInjectionFlowBeforeReenter).toHaveBeenCalledTimes(1);
    expect(executeNested).toHaveBeenCalledTimes(1);
    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput.entryEndpoint).toBe(entryEndpoint);
    expect(nestedInput.metadata).toMatchObject({
      routecodexLocalPort: 5555,
      routecodexPortMode: 'router',
      direction: 'request',
      stage: 'inbound'
    });
    expect(nestedInput.metadata.__rt.serverToolFollowup).toBe(true);
    expect(result.body).toMatchObject({
      entryEndpoint,
      stage: 'inbound',
      direction: 'request',
      followup: true
    });
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
    expect(result).toEqual({});
  });

  it('does not start servertool followup when client abort signal is already closed', async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('CLIENT_RESPONSE_CLOSED'), {
      code: 'CLIENT_DISCONNECTED',
      name: 'AbortError'
    }));
    const executeNested = jest.fn(async () => ({ status: 200, body: { unexpected: true } }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await expect(executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_client_aborted_before_start',
      body: { input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true } },
      baseMetadata: { clientAbortSignal: controller.signal },
      executeNested
    })).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });

    expect(mockRunClientInjectionFlowBeforeReenter).not.toHaveBeenCalled();
    expect(executeNested).not.toHaveBeenCalled();
  });

  it('preserves live client abort signal into nested followup metadata', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const controller = new AbortController();
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        aborted: input.metadata?.clientAbortSignal?.aborted === true,
        sameSignal: input.metadata?.clientAbortSignal === controller.signal
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_preserve_abort_signal',
      body: { input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true } },
      baseMetadata: { clientAbortSignal: controller.signal },
      executeNested
    });

    expect(result.body).toMatchObject({ aborted: false, sameSignal: true });
  });

  it('keeps followup stopMessage enabled only when flow policy preserves eligibility', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        stopMessageEnabled: input.metadata?.stopMessageEnabled,
        routecodexPortStopMessageEnabled: input.metadata?.routecodexPortStopMessageEnabled,
        rtStopMessageEnabled: input.metadata?.__rt?.stopMessageEnabled,
        rtPortStopMessageEnabled: input.metadata?.__rt?.routecodexPortStopMessageEnabled
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_stopmessage_disabled_nested',
      body: { input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true, stopMessageFollowupPolicy: 'preserve_eligibility' } },
      baseMetadata: { stopMessageEnabled: true, routecodexPortStopMessageEnabled: true },
      executeNested
    });

    expect(result.body).toEqual({
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      rtStopMessageEnabled: undefined,
      rtPortStopMessageEnabled: undefined
    });
  });

  it('does not preserve stopMessage eligibility from source or flowId without explicit flow policy', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        stopMessageEnabled: input.metadata?.stopMessageEnabled,
        routecodexPortStopMessageEnabled: input.metadata?.routecodexPortStopMessageEnabled,
        rtStopMessageEnabled: input.metadata?.__rt?.stopMessageEnabled,
        rtPortStopMessageEnabled: input.metadata?.__rt?.routecodexPortStopMessageEnabled,
        flowId: input.metadata?.__rt?.serverToolLoopState?.flowId
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_stopmessage_loopstate_enabled_nested',
      body: { input: 'continue' },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.stop_message',
          serverToolLoopState: { flowId: 'stop_message_flow', repeatCount: 1 },
          stopMessageEnabled: false,
          routecodexPortStopMessageEnabled: false
        }
      },
      baseMetadata: { stopMessageEnabled: true, routecodexPortStopMessageEnabled: true },
      executeNested
    });

    expect(result.body).toEqual({
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      rtStopMessageEnabled: false,
      rtPortStopMessageEnabled: false,
      flowId: 'stop_message_flow'
    });
  });

  it('keeps stopMessage eligibility when loopState flow is paired with explicit preserve policy', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        stopMessageEnabled: input.metadata?.stopMessageEnabled,
        routecodexPortStopMessageEnabled: input.metadata?.routecodexPortStopMessageEnabled,
        rtStopMessageEnabled: input.metadata?.__rt?.stopMessageEnabled,
        rtPortStopMessageEnabled: input.metadata?.__rt?.routecodexPortStopMessageEnabled,
        flowId: input.metadata?.__rt?.serverToolLoopState?.flowId,
        policy: input.metadata?.__rt?.stopMessageFollowupPolicy
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_stopmessage_policy_enabled_nested',
      body: { input: 'continue' },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: { flowId: 'stop_message_flow', repeatCount: 1 },
          stopMessageFollowupPolicy: 'preserve_eligibility',
          stopMessageEnabled: false,
          routecodexPortStopMessageEnabled: false
        }
      },
      baseMetadata: { stopMessageEnabled: true, routecodexPortStopMessageEnabled: true },
      executeNested
    });

    expect(result.body).toEqual({
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      rtStopMessageEnabled: undefined,
      rtPortStopMessageEnabled: undefined,
      flowId: 'stop_message_flow',
      policy: 'preserve_eligibility'
    });
  });

  it('does not rebuild stopMessage followup budget from root loop state in nested metadata builder', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        loopState: input.metadata?.__rt?.serverToolLoopState,
        policy: input.metadata?.__rt?.stopMessageFollowupPolicy
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_stopmessage_root_budget_nested',
      body: { input: 'continue' },
      metadata: {
        serverToolLoopState: { flowId: 'stop_message_flow', maxRepeats: 3, repeatCount: 1 },
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: { flowId: 'stop_message_flow', repeatCount: 1 },
          stopMessageFollowupPolicy: 'preserve_eligibility'
        }
      },
      baseMetadata: { stopMessageEnabled: true, routecodexPortStopMessageEnabled: true },
      executeNested
    });

    expect(result.body).toEqual({
      loopState: { flowId: 'stop_message_flow', repeatCount: 1 },
      policy: 'preserve_eligibility'
    });
  });

  it('disables non-stop_message nested followup metadata to prevent generic servertool recursion', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        stopMessageEnabled: input.metadata?.stopMessageEnabled,
        routecodexPortStopMessageEnabled: input.metadata?.routecodexPortStopMessageEnabled,
        rtStopMessageEnabled: input.metadata?.__rt?.stopMessageEnabled,
        rtPortStopMessageEnabled: input.metadata?.__rt?.routecodexPortStopMessageEnabled
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const result = await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_non_stopmessage_disabled_nested',
      body: { input: 'continue' },
      metadata: { __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.apply_patch_read_before_retry' } },
      baseMetadata: { stopMessageEnabled: true, routecodexPortStopMessageEnabled: true },
      executeNested
    });

    expect(result.body).toEqual({
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      rtStopMessageEnabled: false,
      rtPortStopMessageEnabled: false
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

  it('goal-capable followup restores full client goal tools instead of stale reasoning.stop-only tools', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        tools: input.body?.tools,
        semantics: input.body?.semantics
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const goalTools = [
      { type: 'function', function: { name: 'get_goal', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'update_goal', parameters: { type: 'object' } } },
      {
        type: 'function',
        function: {
          name: 'request_user_input',
          parameters: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    options: {
                      type: 'array',
                      items: { type: 'object', properties: { label: { type: 'string' } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    ];

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_goal_followup_tools',
      body: {
        input: 'continue',
        tools: [{ type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }]
      },
      metadata: {
        __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.reasoning_stop_guard' }
      },
      requestSemantics: {
        tools: {
          clientToolsRaw: goalTools
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.tools?.map((tool: any) => tool?.function?.name)).toEqual([
      'get_goal',
      'update_goal',
      'request_user_input'
    ]);
    expect(JSON.stringify(nestedInput?.body?.tools)).not.toContain('reasoning.stop');
    expect(nestedInput?.body?.tools?.[2]?.function?.parameters?.properties?.questions?.items?.properties?.options?.items)
      .toEqual({ type: 'object', properties: { label: { type: 'string' } } });
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
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.reasoning).toBeUndefined();
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
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.reasoning).toBeUndefined();
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

  it('reenter path strips responses-only request settings without stripping followup tool_choice', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        semantics: input.body?.semantics,
        requestSemantics: input.metadata?.requestSemantics,
        body: input.body
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    const requestSemantics = {
      responses: {
        requestParameters: {
          model: 'MiniMax-M2.7',
          max_tokens: 8192,
          max_output_tokens: 8192,
          parallel_tool_calls: true,
          tool_choice: 'auto',
          reasoning: { effort: 'medium', summary: 'detailed' }
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
      },
      __routecodex: {
        serverToolFollowup: true,
        serverToolFollowupSource: 'servertool.apply_patch_read_before_retry'
      }
    };

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_apply_patch_strip_responses_settings',
      body: {
        model: 'MiniMax-M2.7',
        max_tokens: 8192,
        parallel_tool_calls: true,
        reasoning: { effort: 'medium', summary: 'detailed' },
        messages: [
          { role: 'assistant', content: '' },
          {
            role: 'tool',
            name: 'apply_patch',
            tool_call_id: 'call_function_su9qqmws1kil_1',
            content: '{"ok":false,"code":"APPLY_PATCH_REQUIRES_READ_BEFORE_RETRY"}'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'mcp__computer_use__click',
              parameters: { type: 'object', properties: { x: { type: 'number' } } }
            }
          }
        ]
      },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.apply_patch_read_before_retry'
        }
      },
      requestSemantics,
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.max_tokens).toBeUndefined();
    expect(nestedInput?.body?.max_output_tokens).toBeUndefined();
    expect(nestedInput?.body?.parallel_tool_calls).toBeUndefined();
    expect(nestedInput?.body?.tool_choice).toBe('auto');
    expect(nestedInput?.body?.reasoning).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.model).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.max_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.parallel_tool_calls).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.tool_choice).toBe('auto');
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.reasoning).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.responses?.requestParameters?.stream).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.model).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.max_tokens).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.max_output_tokens).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.parallel_tool_calls).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.tool_choice).toBe('auto');
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.reasoning).toBeUndefined();
    expect((nestedInput?.metadata?.requestSemantics as any)?.responses?.requestParameters?.stream).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.__routecodex?.serverToolFollowup).toBe(true);
    expect((nestedInput?.metadata?.requestSemantics as any)?.__routecodex?.serverToolFollowup).toBe(true);
  });

  it('treats followup source marker alone as servertool followup for sanitize gates', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { body: input.body, metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_source_only_sets_followup_flag',
      body: {
        model: 'MiniMax-M2.7',
        max_tokens: 8192,
        parallel_tool_calls: true,
        reasoning: { effort: 'medium', summary: 'detailed' }
      },
      metadata: {
        __rt: {
          clientInjectSource: 'servertool.apply_patch_read_before_retry'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.max_tokens).toBeUndefined();
    expect(nestedInput?.body?.parallel_tool_calls).toBeUndefined();
    expect(nestedInput?.body?.reasoning).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.__routecodex?.serverToolFollowup).toBe(true);
    expect((nestedInput?.metadata?.requestSemantics as any)?.__routecodex?.serverToolFollowupSource).toBe(
      'servertool.apply_patch_read_before_retry'
    );
  });

  it('does not pass legacy responsesContext through nested followup metadata', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { body: input.body, metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_no_legacy_responses_context_metadata',
      body: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      },
      baseMetadata: {
        responsesContext: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'seed' }] }] },
        contextSnapshot: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'seed' }] }] },
        contextMetadataKey: 'responsesContext'
      },
      metadata: {
        __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.stop_message' }
      },
      requestSemantics: {
        responses: {
          context: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'seed' }] }] }
        },
        __routecodex: {
          serverToolFollowup: true,
          serverToolFollowupSource: 'servertool.stop_message'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata?.responsesContext).toBeUndefined();
    expect(nestedInput?.metadata?.contextSnapshot).toBeUndefined();
    expect(nestedInput?.metadata?.contextMetadataKey).toBeUndefined();
    expect(nestedInput?.metadata?.requestSemantics?.responses?.context).toBeDefined();
  });

  it('disables servertool followup semantics when stopless goal is active (from request semantics)', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { body: input.body, metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_goal_active_disables_followup',
      body: {
        model: 'gpt-5.3-codex',
        max_tokens: 8192,
        input: 'continue'
      },
      metadata: {
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.stop_message'
        }
      },
      requestSemantics: {
        stoplessGoalState: { status: 'active' },
        __routecodex: {
          serverToolFollowup: true,
          serverToolFollowupSource: 'servertool.stop_message'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    const routecodex = (nestedInput?.metadata?.requestSemantics as any)?.__routecodex ?? {};
    expect(routecodex.stoplessGoalStatus).toBe('active');
    expect(routecodex.serverToolFollowup).toBeUndefined();
    expect(routecodex.serverToolFollowupSource).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.__routecodex?.serverToolFollowup).toBeUndefined();
    expect((nestedInput?.body?.semantics as any)?.__routecodex?.serverToolFollowupSource).toBeUndefined();
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

  it('reenter path must not retry when nested followup fails with terminal HTTP 403', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async () => ({
      status: 403,
      body: {
        error: {
          message: 'HTTP 403: {"error":{"message":"token cannot use model minimax"}}',
          code: 'HTTP_403',
          upstreamCode: 'HTTP_403'
        }
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await expect(
      executeServerToolReenterPipeline({
        entryEndpoint: '/v1/responses',
        fallbackEntryEndpoint: '/v1/responses',
        requestId: 'req_followup_dispatch_terminal_403_no_retry',
        body: { model: 'MiniMax-M2.7', input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }] },
        metadata: {
          __shadowCompareForcedProviderKey: 'mini27.key1.MiniMax-M2.7'
        },
        executeNested
      })
    ).rejects.toMatchObject({
      code: 'HTTP_403',
      upstreamCode: 'HTTP_403',
      status: 403
    });

    expect(executeNested).toHaveBeenCalledTimes(1);
  });

  it('reenter path strips SSE accept header when followup payload is non-streaming', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { headers: input.headers, stream: input.body?.stream }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_strip_sse_accept',
      body: {
        model: 'gpt-5.3-codex',
        stream: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      },
      metadata: {
        __rt: { serverToolFollowup: true },
        clientHeaders: {
          accept: 'text/event-stream',
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.stream).toBe(false);
    expect(nestedInput?.headers?.accept).toBeUndefined();
    expect(nestedInput?.headers?.authorization).toBe('Bearer test-token');
    expect(nestedInput?.headers?.['content-type']).toBe('application/json');
  });

  it('reenter path must not retry when nested followup fails with terminal CONTEXT_LENGTH_EXCEEDED', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async () => ({
      status: 400,
      body: {
        error: {
          message: '[hub_response] invalid params, context window exceeds limit',
          code: 'CONTEXT_LENGTH_EXCEEDED',
          upstreamCode: 'context_length_exceeded'
        }
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await expect(
      executeServerToolReenterPipeline({
        entryEndpoint: '/v1/responses',
        fallbackEntryEndpoint: '/v1/responses',
        requestId: 'req_followup_dispatch_terminal_context_length_no_retry',
        body: { model: 'MiniMax-M2.7', input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }] },
        metadata: {
          __shadowCompareForcedProviderKey: 'mini27.key1.MiniMax-M2.7'
        },
        executeNested
      })
    ).rejects.toMatchObject({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      upstreamCode: 'context_length_exceeded',
      status: 400
    });

    expect(executeNested).toHaveBeenCalledTimes(1);
  });

  it('reenter path strips stale tmux injection metadata from stop_followup reenter requests', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_strip_tmux_metadata',
      body: {
        model: 'gpt-5.3-codex',
        stream: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      },
      metadata: {
        __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.stop_message' },
        clientInjectOnly: true,
        clientInjectText: '继续执行',
        clientTmuxSessionId: 'tmux_legacy',
        tmuxSessionId: 'tmux_legacy',
        inboundStream: true,
        clientAcceptsSse: true,
        stream: true
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata?.clientInjectOnly).toBeUndefined();
    expect(nestedInput?.metadata?.clientInjectText).toBeUndefined();
    expect(nestedInput?.metadata?.clientTmuxSessionId).toBeUndefined();
    expect(nestedInput?.metadata?.tmuxSessionId).toBeUndefined();
    expect(nestedInput?.metadata?.inboundStream).toBeUndefined();
    expect(nestedInput?.metadata?.clientAcceptsSse).toBeUndefined();
    expect(nestedInput?.metadata?.stream).toBeUndefined();
  });

  it('reenter responses followup marks function_call_output input as tool-result turn after messages are normalized', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { body: input.body, metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'req_followup_dispatch_apply_patch_tool_result_semantics',
      body: {
        model: 'MiniMax-M2.7',
        messages: [
          { role: 'user', content: 'edit sample' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_apply_patch_1',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"filePath":"sample.txt"}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_apply_patch_1', content: '{"status":"APPLY_PATCH_APPLIED","ok":true}' }
        ]
      },
      metadata: {
        __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.apply_patch_flow' }
      },
      requestSemantics: {
        tools: { clientToolsRaw: [{ type: 'function', function: { name: 'apply_patch' } }] },
        responses: { requestParameters: { tool_choice: 'required' } }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.messages).toBeUndefined();
    expect(nestedInput?.body?.input?.some((entry: any) => entry?.type === 'function_call_output')).toBe(true);
    expect(nestedInput?.body?.semantics?.toolOutputs?.length).toBe(1);
    expect(nestedInput?.metadata?.requestSemantics?.tools?.clientToolsRaw).toHaveLength(1);
  });

  it('RED: stop_followup preserves client tool_choice as normal request semantics', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { body: input.body, metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'openai-responses-minimax.key1-MiniMax-M3-20260603T080503707-252032-5543:stop_followup',
      body: {
        model: 'gpt-5.5',
        stream: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }],
        tools: [{ type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: {} } }],
        tool_choice: { type: 'auto' },
        max_output_tokens: 8192
      },
      metadata: {
        __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.stop_message' }
      },
      requestSemantics: {
        __routecodex: { serverToolFollowup: true, serverToolFollowupSource: 'servertool.stop_message' },
        tools: { clientToolsRaw: [{ type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: {} } }] },
        responses: { requestParameters: { tool_choice: { type: 'auto' }, max_output_tokens: 8192 } }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.body?.tool_choice).toEqual({ type: 'auto' });
    expect(nestedInput?.body?.tools).toHaveLength(1);
  });

  it('strips legacy responses context metadata before stop_followup hub reentry', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async (input: any) => ({
      status: 200,
      body: { metadata: input.metadata }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'openai-responses-mimo.key2-mimo-v2.5-20260531T205435169-242642-2103:stop_followup',
      body: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      },
      baseMetadata: {
        responsesContext: { previous_response_id: 'resp_base' },
        extraFields: { store: true },
        __rt: {
          serverToolFollowup: true,
          responsesContext: { previous_response_id: 'resp_rt_base' },
          extraFields: { store: true }
        }
      },
      metadata: {
        responses_context: { previous_response_id: 'resp_extra' },
        extra_fields: { store: true },
        responseFormat: { type: 'json_object' },
        __rt: {
          serverToolFollowup: true,
          responses_context: { previous_response_id: 'resp_rt_extra' },
          extra_fields: { store: true }
        }
      },
      requestSemantics: {
        __routecodex: { serverToolFollowup: true, serverToolFollowupSource: 'servertool.stop_message_flow' },
        responses: { context: { previous_response_id: 'resp_semantics' } }
      },
      executeNested
    });

    const nestedInput = executeNested.mock.calls[0]?.[0] as Record<string, any>;
    expect(nestedInput?.metadata).not.toHaveProperty('responsesContext');
    expect(nestedInput?.metadata).not.toHaveProperty('responses_context');
    expect(nestedInput?.metadata).not.toHaveProperty('extraFields');
    expect(nestedInput?.metadata).not.toHaveProperty('extra_fields');
    expect(nestedInput?.metadata).not.toHaveProperty('responseFormat');
    expect(nestedInput?.metadata?.__rt).not.toHaveProperty('responsesContext');
    expect(nestedInput?.metadata?.__rt).not.toHaveProperty('responses_context');
    expect(nestedInput?.metadata?.__rt).not.toHaveProperty('extraFields');
    expect(nestedInput?.metadata?.__rt).not.toHaveProperty('extra_fields');
    expect(nestedInput?.body?.semantics?.responses?.context?.previous_response_id).toBe('resp_semantics');
  });

  it('RED: stop_followup continuation rebinds captured responses context to final response id', async () => {
    mockRunClientInjectionFlowBeforeReenter.mockResolvedValue({ clientInjectOnlyHandled: false });
    const executeNested = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp_stop_followup_final_1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
      }
    }));

    const { executeServerToolReenterPipeline } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
    );

    await executeServerToolReenterPipeline({
      entryEndpoint: '/v1/responses',
      fallbackEntryEndpoint: '/v1/responses',
      requestId: 'openai-responses-mini27.key1-MiniMax-M2.7-20260529T130405241-233047-358:stop_followup',
      body: {
        model: 'MiniMax-M2.7',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
        store: true
      },
      executeNested
    });

    expect(mockCaptureResponsesRequestContext).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'openai-responses-mini27.key1-MiniMax-M2.7-20260529T130405241-233047-358:stop_followup'
    }));
    expect(mockRebindResponsesConversationRequestId).toHaveBeenCalledWith(
      'openai-responses-mini27.key1-MiniMax-M2.7-20260529T130405241-233047-358:stop_followup',
      'resp_stop_followup_final_1'
    );
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
