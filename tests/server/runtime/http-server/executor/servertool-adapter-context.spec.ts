import { describe, expect, it, jest } from '@jest/globals';

const mockSyncStoplessGoalStateFromRequest = jest.fn((baseContext: Record<string, unknown>) => {
  baseContext.stoplessGoalState = {
    status: 'active',
    objective: 'continue',
    updatedAt: 1,
    createdAt: 1
  };
  return {
    stickyKey: 'session:test',
    hadDirective: false,
    directiveTypes: [],
    state: baseContext.stoplessGoalState
  };
});

const mockBridgeModule = () => ({
  syncStoplessGoalStateFromRequest: mockSyncStoplessGoalStateFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('servertool adapter context builder', () => {
  it('builds shared adapter context with request semantics and inject readiness', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const originalRequest = {
      model: 'client-model',
      messages: [{ role: 'user', content: '继续' }]
    };

    const context = buildServerToolAdapterContext({
      metadata: {
        routeName: 'thinking-primary',
        assignedModelId: 'kimi-k2.5',
        sessionId: 'sess-1',
        clientTmuxSessionId: 'tmux-1',
        target: {
          compatibilityProfile: 'anthropic-claude'
        },
        __rt: {
          existing: true
        }
      },
      originalRequest,
      requestSemantics: {
        tools: {
          clientToolsRaw: [{ type: 'function', function: { name: 'exec_command' } }]
        }
      },
      requestId: 'req-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: false
    });

    expect(context.requestId).toBe('req-1');
    expect(context.entryEndpoint).toBe('/v1/responses');
    expect(context.providerProtocol).toBe('openai-responses');
    expect(context.routeId).toBe('thinking-primary');
    expect(context.originalModelId).toBe('client-model');
    expect(context.modelId).toBe('kimi-k2.5');
    expect(context.compatibilityProfile).toBe('anthropic-claude');
    expect(context.serverToolsEnabled).toBe(false);
    expect(context.serverToolsDisabled).toBe(true);
    expect((context.__rt as Record<string, unknown>).existing).toBe(true);
    expect((context.__rt as Record<string, unknown>).stopMessageClientInjectReady).toBe(true);
    expect((context.__rt as Record<string, unknown>).stopMessageClientInjectTmuxSessionId).toBe('tmux-1');
    expect(Array.isArray((context.capturedChatRequest as Record<string, unknown>).tools)).toBe(true);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });

  it('replaces followup-collapsed reasoning.stop-only captured tools with original clientToolsRaw', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedChatRequest: {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: '继续执行' }],
          tools: [
            {
              type: 'function',
              function: { name: 'reasoning.stop', parameters: { type: 'object' } }
            }
          ]
        },
        __rt: {
          serverToolFollowup: true
        }
      },
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: { name: 'exec_command', parameters: { type: 'object' } }
            },
            {
              type: 'function',
              function: { name: 'apply_patch', parameters: { type: 'object' } }
            },
            {
              type: 'function',
              function: { name: 'reasoning.stop', parameters: { type: 'object' } }
            }
          ]
        }
      },
      requestId: 'req-followup-tools-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    const toolNames = (((context.capturedChatRequest as Record<string, unknown>).tools as Array<any>) ?? [])
      .map((tool) => tool?.function?.name);
    expect(toolNames).toEqual(['exec_command', 'apply_patch', 'reasoning.stop']);
  });

  it('recognizes anthropic-style top-level tool names when deciding whether to restore original client tools', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedChatRequest: {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: '继续执行' }],
          tools: [
            {
              name: 'reasoning.stop',
              input_schema: { type: 'object' }
            }
          ]
        },
        __rt: {
          serverToolFollowup: true
        }
      },
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: { name: 'exec_command', parameters: { type: 'object' } }
            },
            {
              type: 'function',
              function: { name: 'reasoning.stop', parameters: { type: 'object' } }
            }
          ]
        }
      },
      requestId: 'req-followup-tools-anthropic-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    const tools = (((context.capturedChatRequest as Record<string, unknown>).tools as Array<any>) ?? []);
    const toolNames = tools.map((tool) => tool?.function?.name ?? tool?.name);
    expect(toolNames).toEqual(['exec_command', 'reasoning.stop']);
  });

  it('managed stopless goal followup still restores ordinary client tools instead of treating them as goal-only tools', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedChatRequest: {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: '继续执行' }],
          tools: [
            {
              type: 'function',
              function: { name: 'reasoning.stop', parameters: { type: 'object' } }
            }
          ]
        },
        __rt: {
          serverToolFollowup: true
        }
      },
      requestSemantics: {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: { name: 'exec_command', parameters: { type: 'object' } }
            },
            {
              type: 'function',
              function: { name: 'apply_patch', parameters: { type: 'object' } }
            }
          ]
        }
      },
      requestId: 'req-managed-goal-tools-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect((context.stoplessGoalState as Record<string, unknown>)?.status).toBe('active');
    const toolNames = (((context.capturedChatRequest as Record<string, unknown>).tools as Array<any>) ?? [])
      .map((tool) => tool?.function?.name);
    expect(toolNames).toEqual(['exec_command', 'apply_patch']);
  });



  it('forwards reasoning stop seed errors to onReasoningStopSeedError callback', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();
    const onError = jest.fn();
    mockSyncStoplessGoalStateFromRequest.mockImplementationOnce(() => {
      throw new Error('stopless-goal seed failed');
    });

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    buildServerToolAdapterContext({
      metadata: {},
      originalRequest: {
        messages: [{ role: 'user', content: '<**rcc**>\nstopless start\n继续\n</rcc**>' }]
      },
      requestId: 'req-fail',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      onReasoningStopSeedError: onError
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error('stopless-goal seed failed'));
  });

  it('prefers original request as captured chat request for RCC stopless goal sync', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const originalRequest = {
      messages: [{ role: 'user', content: '<**rcc**>\nstopless start\n继续\n</rcc**>' }]
    };
    const existingCaptured = {
      messages: [{ role: 'user', content: '普通请求' }]
    };

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedChatRequest: existingCaptured
      },
      originalRequest,
      requestId: 'req-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.capturedChatRequest).toBe(originalRequest);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });

});
