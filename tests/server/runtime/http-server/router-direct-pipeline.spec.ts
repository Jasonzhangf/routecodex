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
  const processIncomingDirect = jest.fn(async (payload: Record<string, unknown>) => ({
    status: 200,
    body: { ...payload, _routed: true, _direct: true },
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
      processIncomingDirect,
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
        requestPayload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'raw' }] },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey, processMode: 'chat' },
        routingDecision: { routeName: 'default', pool: ['openai.gpt-4'] },
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
      expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledWith(input.requestPayload);
      const ctx = result.auditContext;
      expect(ctx.observedFields).toBeDefined();
      expect(ctx.originalPayload).toEqual(input.requestPayload);
      expect(ctx.providerKey).toBe('openai.gpt-4');
      expect(ctx.inboundProtocol).toBe('openai-chat');
      expect(ctx.providerProtocol).toBe('openai-chat');
    });

    it('passes apply_patch payload through unchanged in router direct mode', async () => {
      const applyPatchTool = {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'canonical client apply_patch tool',
          parameters: {
            type: 'object',
            properties: { patch: { type: 'string' } },
            required: ['patch'],
            additionalProperties: false,
          },
        },
      };
      const applyPatchArguments = JSON.stringify({
        patch: '*** Begin Patch\n*** Add File: direct-router.txt\n+ok\n*** End Patch',
      });
      const requestPayload = {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'edit a file' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_apply_patch_direct_router',
                type: 'function',
                function: { name: 'apply_patch', arguments: applyPatchArguments },
              },
            ],
          },
        ],
        tools: [applyPatchTool],
      } as Record<string, unknown>;
      const originalSnapshot = structuredClone(requestPayload);
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'edit a file' }] },
        requestPayload,
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey, processMode: 'chat' },
        routingDecision: { routeName: 'default', pool: ['openai.gpt-4'] },
        processMode: 'chat',
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
      const sentPayload = (openaiHandle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).toBe(requestPayload);
      expect(sentPayload).toEqual(originalSnapshot);
      expect(JSON.stringify(sentPayload)).not.toContain('hashline-first');
      expect(JSON.stringify(sentPayload)).not.toContain('fileContent');
      expect(openaiHandle.instance.processIncoming).not.toHaveBeenCalled();
    });

    it('skips when protocols do not match', async () => {
      const anthropicHandle = createMockProviderHandle('anthropic-messages');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'claude-3', messages: [{ role: 'user', content: 'hello' }] },
        requestPayload: { model: 'claude-3', messages: [{ role: 'user', content: 'raw' }] },
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
        requestPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'raw' }] },
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
        requestPayload: { model: 'gpt-4' },
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
        requestPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'raw' }] },
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
      expect(beforeSnapshots[0].ctx.originalPayload).toEqual(input.requestPayload);
      expect(beforeSnapshots[0].ctx).toBe(afterSnapshots[0].ctx);
    });
  });

  describe('openai-responses protocol', () => {
    it('RED: skips responses same-protocol direct because Responses requires conversation and outbound conversion', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5', reasoning: { effort: 'high' } },
        requestPayload: { model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }] },
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'default' },
        processMode: 'chat',
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('full executor conversion');
      expect(handle.instance.processIncomingDirect).not.toHaveBeenCalled();
    });

    it('skips when chat inbound targets responses provider', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5' },
        requestPayload: { model: 'gpt-5.4' },
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

    it('skips Windsurf responses even when protocols match because full executor response conversion is required', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'windsurf',
        providerFamily: 'windsurf',
      } as ProviderHandle;
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-medium' },
        requestPayload: { model: 'gpt-5.4-medium', input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }] },
        target: { providerKey: 'windsurf.ws-pro-4.gpt-5.4-medium', providerType: 'openai', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'thinking' },
        processMode: 'standard',
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('full executor conversion');
      expect(handle.instance.processIncomingDirect).not.toHaveBeenCalled();
      expect(handle.instance.processIncoming).not.toHaveBeenCalled();
    });


  });
});
