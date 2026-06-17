import { describe, expect, it, jest } from '@jest/globals';

const mockSyncStoplessGoalStateFromRequest = jest.fn((baseContext: Record<string, unknown>) => {
  baseContext.stoplessGoalState = {
    status: 'active',
    objective: 'continue',
    updatedAt: 1,
    createdAt: 1
  };
  return {
    stateKey: 'session:test',
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
  it('builds shared adapter context from entry origin request and metadata', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const entryOriginRequest = {
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
      entryOriginRequest,
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
    expect(context.capturedEntryRequest).toBe(entryOriginRequest);
    expect(context.capturedChatRequest).toBe(entryOriginRequest);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });

  it('maps routeHint into routeId for stop followup planning', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        routeHint: 'search',
        routecodexPortMode: 'router'
      },
      entryOriginRequest: { model: 'gpt-5.5', input: 'continue' },
      requestSemantics: {},
      requestId: 'req-route-hint',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      serverToolsEnabled: true
    });

    expect(context.routeId).toBe('search');
  });

  it('backfills session and conversation identifiers from entry origin request metadata', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {},
      entryOriginRequest: {
        metadata: {
          sessionId: 'sess-origin',
          conversationId: 'conv-origin'
        },
        input: 'continue'
      },
      requestId: 'req-session-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-origin');
    expect(context.conversationId).toBe('conv-origin');
  });

  it('backfills session and conversation identifiers from relay responsesRequestContext metadata', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        responsesRequestContext: {
          sessionId: 'sess-relay',
          conversationId: 'conv-relay'
        }
      },
      requestId: 'req-session-relay-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-relay');
    expect(context.conversationId).toBe('conv-relay');
  });

  it('backfills session and conversation identifiers from nested __rt.responsesRequestContext metadata', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        __rt: {
          responsesRequestContext: {
            sessionId: 'sess-relay-rt',
            conversationId: 'conv-relay-rt'
          }
        }
      },
      requestId: 'req-session-relay-rt-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-relay-rt');
    expect(context.conversationId).toBe('conv-relay-rt');
  });

  it('backfills session and conversation identifiers from metadata.sessionId without entry origin request', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        sessionId: 'sess-meta-direct',
        conversationId: 'conv-meta-direct'
      },
      requestId: 'req-session-meta-direct-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-meta-direct');
    expect(context.conversationId).toBe('conv-meta-direct');
  });

  it('backfills session and conversation identifiers from __rt.sessionId without entry origin request', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const context = buildServerToolAdapterContext({
      metadata: {
        __rt: {
          sessionId: 'sess-rt-direct',
          conversationId: 'conv-rt-direct'
        }
      },
      requestId: 'req-session-rt-direct-backfill',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.sessionId).toBe('sess-rt-direct');
    expect(context.conversationId).toBe('conv-rt-direct');
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
      entryOriginRequest: {
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

  it('overrides captured chat request with RCC fenced entry origin request for goal sync', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const entryOriginRequest = {
      messages: [{ role: 'user', content: '<**rcc**>\nstopless start\n继续\n</rcc**>' }]
    };
    const existingCaptured = {
      messages: [{ role: 'user', content: '普通请求' }]
    };

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedChatRequest: existingCaptured
      },
      entryOriginRequest,
      requestId: 'req-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.capturedChatRequest).toBe(entryOriginRequest);
    expect(context.capturedEntryRequest).toBe(entryOriginRequest);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });

  it('uses /v1/responses input-array entry origin request as captured chat request for RCC goal sync', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const entryOriginRequest = {
      input: [
        {
          role: 'user',
          content: '<**rcc**>\nstopless start\n继续推进 live goal\n</rcc**>\n继续执行验证'
        }
      ]
    };

    const context = buildServerToolAdapterContext({
      metadata: {},
      entryOriginRequest,
      requestId: 'req-responses-rcc-goal-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.capturedChatRequest).toBe(entryOriginRequest);
    expect(context.capturedEntryRequest).toBe(entryOriginRequest);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to metadata capturedEntryRequest when capturedChatRequest lost RCC fence', async () => {
    jest.resetModules();
    mockSyncStoplessGoalStateFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const metadataCapturedEntryRequest = {
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<**rcc**>\nstopless start\n继续推进 goal sync\n</rcc**>\n继续执行验证'
            }
          ]
        }
      ]
    };

    const context = buildServerToolAdapterContext({
      metadata: {
        capturedEntryRequest: metadataCapturedEntryRequest,
        capturedChatRequest: {
          messages: [{ role: 'user', content: 'stopless start\n继续推进 goal sync\n</rcc**>\n继续执行验证' }]
        }
      },
      requestId: 'req-responses-rcc-goal-fallback-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    });

    expect(context.capturedChatRequest).toBe(metadataCapturedEntryRequest);
    expect(context.capturedEntryRequest).toBe(metadataCapturedEntryRequest);
    expect(mockSyncStoplessGoalStateFromRequest).toHaveBeenCalledTimes(1);
  });
});
