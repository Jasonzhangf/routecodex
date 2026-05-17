import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  executeRouterDirectPipeline,
  isRouterDirectEligible,
  resolveRouterSameProtocolBehavior,
} from '../../../../src/server/runtime/http-server/router-direct-pipeline.js';
import type { PortConfig } from '../../../../src/server/runtime/http-server/port-config-types.js';
import type { ProviderHandle, ProviderProtocol } from '../../../../src/server/runtime/http-server/types.js';

function createMockProviderHandle(protocol: ProviderProtocol): ProviderHandle {
  const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
    status: 200,
    body: { ...payload, _routed: true },
  }));
  return {
    runtimeKey: 'runtime.' + protocol,
    providerId: 'mock',
    providerType: 'mock',
    providerFamily: 'mock',
    providerProtocol: protocol,
    runtime: {} as any,
    instance: {
      initialize: async () => {},
      cleanup: async () => {},
      processIncoming,
    },
  };
}

function createRouterPortConfig(sameProtocolBehavior?: 'direct' | 'relay'): PortConfig {
  return {
    port: 5520,
    host: '0.0.0.0',
    mode: 'router',
    routingPolicyGroup: 'default',
    sameProtocolBehavior,
  };
}

describe('router-direct-pipeline', () => {
  describe('isRouterDirectEligible', () => {
    it('returns true for router-mode port with default direct', () => {
      expect(isRouterDirectEligible(createRouterPortConfig())).toBe(true);
    });
    it('returns true for explicit direct', () => {
      expect(isRouterDirectEligible(createRouterPortConfig('direct'))).toBe(true);
    });
    it('returns false for relay', () => {
      expect(isRouterDirectEligible(createRouterPortConfig('relay'))).toBe(false);
    });
    it('returns false for provider-mode', () => {
      const config: PortConfig = {
        port: 5555, host: '0.0.0.0', mode: 'provider',
        providerBinding: 'openai.gpt-4', protocolBehavior: 'auto',
      };
      expect(isRouterDirectEligible(config)).toBe(false);
    });
  });

  describe('resolveRouterSameProtocolBehavior', () => {
    it('defaults to direct for router', () => {
      expect(resolveRouterSameProtocolBehavior(createRouterPortConfig())).toBe('direct');
    });
    it('returns explicit relay', () => {
      expect(resolveRouterSameProtocolBehavior(createRouterPortConfig('relay'))).toBe('relay');
    });
    it('returns relay for provider-mode', () => {
      const config: PortConfig = {
        port: 5555, host: '0.0.0.0', mode: 'provider',
        providerBinding: 'openai.gpt-4', protocolBehavior: 'auto',
      };
      expect(resolveRouterSameProtocolBehavior(config)).toBe('relay');
    });
  });

  describe('executeRouterDirectPipeline', () => {
    let openaiHandle: ProviderHandle;
    beforeEach(() => { openaiHandle = createMockProviderHandle('openai-chat'); });

    it('uses direct when protocols match', async () => {
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'medium' } },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey, processMode: 'chat' },
        routingDecision: { routeName: 'default', pool: ['openai.gpt-4'] },
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(openaiHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
      const ctx = result.auditContext;
      expect(ctx.observedFields).toBeDefined();
      expect(ctx.originalPayload).toEqual(input.providerPayload);
      expect(ctx.providerKey).toBe('openai.gpt-4');
      expect(ctx.inboundProtocol).toBe('openai-chat');
      expect(ctx.providerProtocol).toBe('openai-chat');
    });

    it('skips when protocols do not match', async () => {
      const anthropicHandle = createMockProviderHandle('anthropic-messages');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'claude-3', messages: [{ role: 'user', content: 'hello' }] },
        target: { providerKey: 'anthropic.claude-3', providerType: 'anthropic', runtimeKey: anthropicHandle.runtimeKey, processMode: 'chat' },
        routingDecision: { routeName: 'default' },
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === anthropicHandle.runtimeKey ? anthropicHandle : undefined,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('protocol mismatch');
      expect(anthropicHandle.instance.processIncoming).not.toHaveBeenCalled();
    });

    it('skips when sameProtocolBehavior is relay', async () => {
      const input = {
        portConfig: createRouterPortConfig('relay'),
        providerPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey, processMode: 'chat' },
        routingDecision: { routeName: 'default' },
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('relay');
    });

    it('skips for provider-mode port', async () => {
      const config: PortConfig = {
        port: 5555, host: '0.0.0.0', mode: 'provider',
        providerBinding: 'openai.gpt-4', protocolBehavior: 'auto',
      };
      const input = {
        portConfig: config,
        providerPayload: { model: 'gpt-4' },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey },
        routingDecision: {},
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => openaiHandle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('not a router-mode port');
    });

    it('calls snapshot hooks', async () => {
      const beforeSnapshots: any[] = [];
      const afterSnapshots: any[] = [];
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-4' },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey },
        routingDecision: {},
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => openaiHandle,
        onSnapshotBefore: (p: any, ctx: any) => beforeSnapshots.push({ payload: p, ctx }),
        onSnapshotAfter: (r: any, ctx: any) => afterSnapshots.push({ response: r, ctx }),
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(beforeSnapshots).toHaveLength(1);
      expect(afterSnapshots).toHaveLength(1);
      expect(beforeSnapshots[0].ctx.originalPayload).toEqual(input.providerPayload);
      expect(beforeSnapshots[0].ctx).toBe(afterSnapshots[0].ctx);
    });
  });

  describe('openai-responses protocol', () => {
    it('applies direct for matching protocol', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5', reasoning: { effort: 'high' } },
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'default' },
        processMode: 'chat',
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    });

    it('skips when chat inbound targets responses provider', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5' },
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: {},
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('protocol mismatch');
    });


    it('returns provider response exactly as-is (response passthrough)', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5', reasoning: { effort: 'high' } },
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'default' },
        processMode: 'chat',
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.response.status).toBe(200);
    expect(result.response.body).toEqual({ model: 'gpt-5', reasoning: { effort: 'high' }, _routed: true });
    });
  });
});