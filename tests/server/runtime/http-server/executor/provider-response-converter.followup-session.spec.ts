import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncStoplessGoalStateFromRequest = jest.fn(() => ({
  stickyKey: 'session:test',
  hadDirective: false,
  directiveTypes: []
}));
const mockPersistStoplessGoalStateSnapshot = jest.fn();
const mockLoadRoutingInstructionStateSync = jest.fn(() => null);
const mockReadStoplessGoalState = jest.fn((adapterContext: Record<string, unknown>) => {
  const sessionId = typeof adapterContext?.sessionId === 'string' ? adapterContext.sessionId : undefined;
  return {
    ...(sessionId ? { stickyKey: `session:${sessionId}` } : {}),
    state: mockLoadRoutingInstructionStateSync(sessionId ? `session:${sessionId}` : '')?.stoplessGoalState
  };
});
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncStoplessGoalStateFromRequest: mockSyncStoplessGoalStateFromRequest,
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot,
  loadRoutingInstructionStateSync: mockLoadRoutingInstructionStateSync,
  readStoplessGoalState: mockReadStoplessGoalState,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

// Jest ESM resolver can map `.js` imports to `.ts` source.
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider-response-converter serverTool followup metadata', () => {
  it('projects create_goal into active stoplessGoalState for goal lifecycle entry', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'resp_goal_create_1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_goal_create_1',
                  type: 'function',
                  function: {
                    name: 'create_goal',
                    arguments: JSON.stringify({
                      objective: 'close stopless onto /goal lifecycle'
                    })
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

    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-create-session',
      capturedChatRequest: {
        tools: [
          {
            type: 'function',
            function: {
              name: 'create_goal',
              parameters: { type: 'object', properties: { objective: { type: 'string' } } }
            }
          }
        ]
      }
    };

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_goal_create_projection_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.status).toBe('active');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.objective)
      .toBe('close stopless onto /goal lifecycle');
    expect(((pipelineMetadata.__rt as Record<string, unknown>) ?? {}).stoplessGoalStatus).toBe('active');
    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'goal-create-session' }),
      expect.objectContaining({
        status: 'active',
        objective: 'close stopless onto /goal lifecycle'
      })
    );
  });

  it('projects validated update_goal complete state back into pipeline metadata', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'resp_goal_completed_1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_goal_completed_1',
                  type: 'function',
                  function: {
                    name: 'update_goal',
                    arguments: JSON.stringify({
                      status: 'complete',
                      completion_evidence: 'targeted tests green',
                      completion_summary: 'goal closed with evidence',
                      ssot_assessment: 'validated at unique host projection point'
                    })
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

    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-completed-session',
      stoplessGoalState: {
        status: 'active',
        objective: 'close stopless on /goal lifecycle',
        updatedAt: 1,
        createdAt: 1
      }
    };

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_goal_completed_projection_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body' } } as any,
        pipelineMetadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.status).toBe('completed');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.objective).toBe('close stopless on /goal lifecycle');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.completionEvidence).toBe('targeted tests green');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.completionSummary).toBe('goal closed with evidence');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.ssotAssessment)
      .toBe('validated at unique host projection point');
    expect(((pipelineMetadata.__rt as Record<string, unknown>) ?? {}).stoplessGoalStatus).toBe('completed');
    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'goal-completed-session' }),
      expect.objectContaining({
        status: 'completed',
        objective: 'close stopless on /goal lifecycle',
        completionEvidence: 'targeted tests green'
      })
    );
  });

  it('forces stopped after two irrecoverable followup failures', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => {
      const error = new Error('followup failed hard') as Error & {
        code?: string;
        retryable?: boolean;
        upstreamCode?: string;
        status?: number;
        statusCode?: number;
        details?: Record<string, unknown>;
      };
      error.code = 'SERVERTOOL_FOLLOWUP_FAILED';
      error.retryable = false;
      error.upstreamCode = 'SERVERTOOL_FOLLOWUP_FAILED';
      error.status = 502;
      error.statusCode = 502;
      error.details = {
        reason: 'followup failed hard',
        requestExecutorProviderErrorStage: 'provider.followup'
      };
      throw error;
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const pipelineMetadata: Record<string, unknown> = {
      stoplessGoalState: {
        status: 'active',
        objective: 'close stopless onto /goal lifecycle',
        updatedAt: 1,
        createdAt: 1
      }
    };

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_goal_irrecoverable_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata
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
      code: 'SERVERTOOL_FOLLOWUP_FAILED'
    });

    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.status).toBe('active');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.consecutiveIrrecoverableErrors).toBe(1);

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_goal_irrecoverable_2',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata
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
      code: 'SERVERTOOL_FOLLOWUP_FAILED'
    });

    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.status).toBe('stopped');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.errorClass).toBe('repeated_irrecoverable_error');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.attemptsExhausted).toBe(true);
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.consecutiveIrrecoverableErrors).toBe(2);
  });

  it('rejects update_goal status aliases outside the minimal shape contract', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'resp_goal_completed_alias_1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_goal_completed_alias_1',
                  type: 'function',
                  function: {
                    name: 'update_goal',
                    arguments: JSON.stringify({
                      goalStatus: 'complete',
                      completionEvidence: 'all required checks passed',
                      completionSummary: 'alias status normalized',
                      ssotAssessment: 'normalized in shared converted-tool validator'
                    })
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

    const pipelineMetadata: Record<string, unknown> = {
      stoplessGoalState: {
        status: 'active',
        objective: 'close stopless on /goal lifecycle',
        updatedAt: 1,
        createdAt: 1
      }
    };

    await expect(
      convertProviderResponseIfNeeded(
        {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          requestId: 'req_goal_completed_alias_projection_1',
          wantsStream: false,
          response: { body: { id: 'upstream_body' } } as any,
          pipelineMetadata
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
      toolName: 'update_goal',
      validationReason: 'missing_status'
    });
  });

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

  it('passes original requestSemantics into nested followup body when followup payload lost client tools', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const executeNested = jest.fn(async (input) => ({
      body: {
        observedSemantics: (input.body as any)?.semantics,
        observedTools: (input.body as any)?.tools
      }
    }));

    mockConvertProviderResponse.mockImplementation(async ({ reenterPipeline }) => {
      const result = await reenterPipeline({
        entryEndpoint: '/v1/responses',
        requestId: 'followup_req_semantics_1',
        body: {
          model: 'mimo-v2.5-pro',
          input: 'continue',
          tools: [
            {
              type: 'function',
              function: {
                name: 'reasoning.stop',
                parameters: { type: 'object' }
              }
            }
          ]
        },
        metadata: {
          __rt: { serverToolFollowup: true, clientInjectSource: 'servertool.reasoning_stop_continue' }
        }
      });
      return { body: result.body ?? { ok: false } };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

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

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_followup_semantics_1',
        wantsStream: false,
        requestSemantics: {
          tools: { clientToolsRaw },
          __routecodex: {
            serverToolFollowup: true,
            serverToolFollowupSource: 'servertool.reasoning_stop_continue'
          }
        } as any,
        response: { body: { id: 'resp_ok', output: [] } } as any,
        pipelineMetadata: {
          capturedChatRequest: {
            model: 'mimo-v2.5-pro',
            input: 'continue'
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
    expect(nestedInput?.body?.tools?.map((tool: any) => tool?.function?.name)).toEqual([
      'exec_command',
      'reasoning.stop'
    ]);
    expect((nestedInput?.body?.semantics as any)?.tools?.clientToolsRaw).toEqual(clientToolsRaw);
    expect(((nestedInput?.body?.semantics as any)?.tools?.clientToolsRaw ?? [])[0]?.function?.name).toBe('exec_command');
    expect((converted.body as any)?.observedSemantics?.tools?.clientToolsRaw?.[0]?.function?.name).toBe('exec_command');
  });

  it('backfills session identifiers from originalRequest metadata before syncing RCC stopless goal state', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncStoplessGoalStateFromRequest.mockReset();
    mockSyncStoplessGoalStateFromRequest.mockImplementation(() => ({
      stickyKey: 'session:sess_stopless_1',
      hadDirective: true,
      directiveTypes: ['stopless.start']
    }));

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

    const pipelineMetadata: Record<string, unknown> = {
      capturedChatRequest: {
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: '<**rcc**>\nstopless start\nhi\n</rcc**>' }]
      }
    };
    mockSyncStoplessGoalStateFromRequest.mockImplementation((context: Record<string, any>) => {
      context.stoplessGoalState = {
        status: 'active',
        objective: 'hi',
        updatedAt: 1,
        createdAt: 1
      };
      context.__rt = {
        ...(context.__rt ?? {}),
        stoplessGoalStatus: 'active'
      };
      return {
        stickyKey: 'session:sess_stopless_1',
        hadDirective: true,
        directiveTypes: ['stopless.start'],
        state: context.stoplessGoalState
      };
    });

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_stopless_session_backfill_1',
        wantsStream: false,
        response: { body: { id: 'upstream_body', choices: [] } } as any,
        originalRequest: {
          model: 'qwen3.6-plus',
          input: '<**rcc**>\nstopless start\nhi\n</rcc**>',
          metadata: {
            sessionId: 'sess_stopless_1',
            conversationId: 'conv_stopless_1'
          }
        },
        pipelineMetadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
    const syncArgs = mockSyncStoplessGoalStateFromRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(syncArgs?.sessionId).toBe('sess_stopless_1');
    expect(syncArgs?.conversationId).toBe('conv_stopless_1');

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.context?.sessionId).toBe('sess_stopless_1');
    expect(bridgeArgs?.context?.conversationId).toBe('conv_stopless_1');
    expect((pipelineMetadata.__rt as Record<string, unknown>)?.stoplessGoalStatus).toBe('active');
    expect((pipelineMetadata.stoplessGoalState as Record<string, unknown>)?.status).toBe('active');
  });
});
