import { describe, expect, it, jest } from '@jest/globals';

const mockSyncReasoningStopModeFromRequest = jest.fn((baseContext: Record<string, unknown>) => {
  baseContext.reasoningStopMode = 'on';
  return 'on';
});

const mockBridgeModule = () => ({
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('servertool adapter context builder', () => {
  it('builds shared adapter context with request semantics and inject readiness', async () => {
    jest.resetModules();
    mockSyncReasoningStopModeFromRequest.mockClear();

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
    expect(mockSyncReasoningStopModeFromRequest).toHaveBeenCalledTimes(1);
  });

  it('prefers original request as captured chat request for stopless sync', async () => {
    jest.resetModules();
    mockSyncReasoningStopModeFromRequest.mockClear();

    const { buildServerToolAdapterContext } = await import(
      '../../../../../src/server/runtime/http-server/executor/servertool-adapter-context.js'
    );

    const originalRequest = {
      messages: [{ role: 'user', content: '<**stopless:on**> 继续' }]
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
    expect(mockSyncReasoningStopModeFromRequest).toHaveBeenCalledTimes(1);
  });
});
