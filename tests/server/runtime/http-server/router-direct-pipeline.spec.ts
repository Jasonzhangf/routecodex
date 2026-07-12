import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';
import type { PortConfig } from '../../../../src/server/runtime/http-server/port-config-types.js';
import type { ProviderHandle, ProviderProtocol } from '../../../../src/server/runtime/http-server/types.js';
import { attachPipelineDryRunControl, readPipelineDryRunControl } from '../../../../src/debug/pipeline-dry-run.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata
} from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';

const {
  applyDirectRouteResponseHooks,
  executeRouterDirectPipeline,
  isRouterDirectEligible,
  resolveRouterSameProtocolBehavior,
} = await import('../../../../src/server/runtime/http-server/router-direct-pipeline.js');

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

  describe('applyDirectRouteResponseHooks (symmetric to request model override)', () => {
    it('restores client model on JSON body', () => {
      const out = applyDirectRouteResponseHooks(
        {
          status: 200,
          body: { id: 'r1', object: 'response', model: 'grok-build', status: 'completed' },
        },
        { originalClientModel: 'gpt-5.5' }
      ) as { body: { model: string } };
      expect(out.body.model).toBe('gpt-5.5');
    });

    it('does not rewrite nested non-protocol model fields on JSON body', () => {
      const out = applyDirectRouteResponseHooks(
        {
          status: 200,
          body: {
            id: 'r1',
            object: 'response',
            model: 'grok-build',
            response: {
              model: 'grok-build',
              diagnostics: { model: 'provider-diagnostic-model' },
            },
            output: [
              { type: 'message', model: 'tool-owned-model' },
            ],
            metadata: { model: 'provider-metadata-model' },
          },
        },
        { originalClientModel: 'gpt-5.5' }
      ) as {
        body: {
          model: string;
          response: { model: string; diagnostics: { model: string } };
          output: Array<{ model: string }>;
          metadata: { model: string };
        };
      };
      expect(out.body.model).toBe('gpt-5.5');
      expect(out.body.response.model).toBe('gpt-5.5');
      expect(out.body.response.diagnostics.model).toBe('provider-diagnostic-model');
      expect(out.body.output[0]?.model).toBe('tool-owned-model');
      expect(out.body.metadata.model).toBe('provider-metadata-model');
    });

    it('restores client model in SSE frames and ensures stream headers', async () => {
      const upstream = Readable.from([
        'event: response.created\n',
        `data: ${JSON.stringify({ type: 'response.created', response: { model: 'grok-build', status: 'in_progress' } })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({ type: 'response.completed', response: { model: 'grok-build', status: 'completed' } })}\n\n`,
      ]);
      const out = applyDirectRouteResponseHooks(
        {
          status: 200,
          headers: { 'x-upstream-mode': 'sse' },
          sseStream: upstream,
        },
        { originalClientModel: 'gpt-5.5' }
      ) as { headers: Record<string, string>; sseStream: Readable };

      expect(out.headers['Content-Type'] || out.headers['content-type']).toMatch(/text\/event-stream/);
      expect(out.headers['Cache-Control'] || out.headers['cache-control']).toBeTruthy();

      const chunks: string[] = [];
      for await (const chunk of out.sseStream) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      }
      const text = chunks.join('');
      expect(text).toContain('"model":"gpt-5.5"');
      expect(text).not.toContain('"model":"grok-build"');
    });

    it('rejects non-readable SSE stream values instead of returning an empty stream', () => {
      expect(() => applyDirectRouteResponseHooks(
        {
          status: 200,
          headers: { 'x-upstream-mode': 'sse' },
          sseStream: { serialized: true },
        },
        { originalClientModel: 'gpt-5.5' }
      )).toThrow(/not a readable stream/);
    });
  });

  describe('executeRouterDirectPipeline', () => {
    let openaiHandle: ProviderHandle;
    beforeEach(() => {
      openaiHandle = createMockProviderHandle('openai-chat');
    });

    it('uses direct when protocols match', async () => {
      const startSpy = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(10_000)
        .mockReturnValueOnce(12_345);
      try {
        const input = {
          portConfig: createRouterPortConfig(),
          providerPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'medium' } },
          requestPayload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'raw' }] },
          target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey },
          routingDecision: { routeName: 'default', pool: ['openai.gpt-4'] },
          requestInfo: { path: '/v1/chat/completions', headers: {} },
          resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
        };
        const result = await executeRouterDirectPipeline(input);
        expect(result.used).toBe(true);
        expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
        expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledWith(input.requestPayload);
        expect(result.externalLatencyStartedAtMs).toBe(10_000);
        expect(result.externalLatencyMs).toBe(2345);
        const ctx = result.auditContext;
        expect(ctx.observedFields).toBeDefined();
        expect(ctx.payload).toBe(input.requestPayload);
        expect(ctx.providerKey).toBe('openai.gpt-4');
        expect(ctx.inboundProtocol).toBe('openai-chat');
        expect(ctx.providerProtocol).toBe('openai-chat');
      } finally {
        startSpy.mockRestore();
      }
    });

    it('does not override chat model with provider payload model before direct send', async () => {
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: {
          model: 'deepseek-v4-flash-free',
          messages: [{ role: 'user', content: 'hello' }],
        },
        requestPayload: {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'hello' }],
        },
        target: {
          providerKey: 'opencode-zen-free.key1.deepseek-v4-flash-free',
          providerType: 'openai',
          runtimeKey: openaiHandle.runtimeKey,
        },
        routingDecision: { routeName: 'thinking', pool: ['opencode-zen-free.key1.deepseek-v4-flash-free'] },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (openaiHandle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).toBe(input.requestPayload);
      expect(sentPayload.model).toBe('deepseek-v4-flash');
      expect(input.requestPayload.model).toBe('deepseek-v4-flash');
    });

    it('propagates provider-request dry-run control from pipeline metadata into direct runtime metadata', async () => {
      const requestPayload = {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'raw' }],
      };
      const pipelineMetadata: Record<string, unknown> = { entryPort: 5520 };
      attachPipelineDryRunControl(pipelineMetadata, {
        enabled: true,
        kind: 'provider_request',
        source: 'sample_replay',
        requestedAtMs: 1
      });
      attachProviderRuntimeMetadata(requestPayload, {
        requestId: 'router_direct_dry_run',
        providerId: 'mock',
        providerKey: 'openai.gpt-5.5',
        providerType: 'mock',
        providerProtocol: 'openai-chat',
        metadata: { entryPort: 5520 }
      });
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'raw' }],
        },
        requestPayload,
        pipelineMetadata,
        target: {
          providerKey: 'openai.gpt-5.5',
          providerType: 'openai',
          runtimeKey: openaiHandle.runtimeKey,
        },
        routingDecision: { routeName: 'thinking', pool: ['openai.gpt-5.5'] },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };

      await executeRouterDirectPipeline(input);

      const sentPayload = (openaiHandle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      const runtimeMetadata = extractProviderRuntimeMetadata(sentPayload);
      expect(readPipelineDryRunControl(runtimeMetadata?.metadata)).toMatchObject({
        kind: 'provider_request',
        source: 'sample_replay'
      });
    });

    it('overrides direct reasoning effort from route thinking config without entering Hub execute', async () => {
      const requestPayload = {
        model: 'gpt-5.5',
        reasoning_effort: 'low',
        reasoning: { effort: 'low', summary: 'auto' },
        messages: [{ role: 'user', content: 'raw' }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'raw' }],
        },
        requestPayload,
        target: {
          providerKey: 'openai.gpt-5.5',
          providerType: 'openai',
          runtimeKey: openaiHandle.runtimeKey,
          routeParams: { thinking: 'medium' },
        },
        routingDecision: { routeName: 'thinking', pool: ['openai.gpt-5.5'] },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (openaiHandle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(result.auditContext.payload).toBe(sentPayload);
      expect(sentPayload).not.toBe(requestPayload);
      expect(sentPayload.model).toBe('gpt-5.5');
      expect(sentPayload.reasoning_effort).toBe('medium');
      expect(sentPayload.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      expect(requestPayload.reasoning_effort).toBe('low');
      expect(requestPayload.reasoning).toEqual({ effort: 'low', summary: 'auto' });
      expect(openaiHandle.instance.processIncoming).not.toHaveBeenCalled();
    });

    it('keeps direct request object untouched when route thinking config is absent', async () => {
      const requestPayload = {
        model: 'gpt-5.5',
        reasoning_effort: 'low',
        reasoning: { effort: 'low' },
        messages: [{ role: 'user', content: 'raw' }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'raw' }],
        },
        requestPayload,
        target: {
          providerKey: 'openai.gpt-5.5',
          providerType: 'openai',
          runtimeKey: openaiHandle.runtimeKey,
          routeParams: {},
        },
        routingDecision: { routeName: 'thinking', pool: ['openai.gpt-5.5'] },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === openaiHandle.runtimeKey ? openaiHandle : undefined,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      expect(openaiHandle.instance.processIncomingDirect).toHaveBeenCalledWith(requestPayload);
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
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey },
        routingDecision: { routeName: 'default', pool: ['openai.gpt-4'] },
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
        target: { providerKey: 'anthropic.claude-3', providerType: 'anthropic', runtimeKey: anthropicHandle.runtimeKey },
        routingDecision: { routeName: 'default' },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: (rt?: string) => rt === anthropicHandle.runtimeKey ? anthropicHandle : undefined,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('protocol mismatch');
      expect(result).not.toHaveProperty('requiresHubRelay');
      expect(anthropicHandle.instance.processIncoming).not.toHaveBeenCalled();
    });

    it('skips when sameProtocolBehavior is relay', async () => {
      const input = {
        portConfig: createRouterPortConfig('relay'),
        providerPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
        requestPayload: { model: 'gpt-4', messages: [{ role: 'user', content: 'raw' }] },
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: openaiHandle.runtimeKey },
        routingDecision: { routeName: 'default' },
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
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => openaiHandle,
        onSnapshotBefore: (p: any, ctx: any) => beforeSnapshots.push({ payload: p, ctx }),
        onSnapshotAfter: (r: any, ctx: any) => afterSnapshots.push({ response: r, ctx }),
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(beforeSnapshots).toHaveLength(1);
      expect(afterSnapshots).toHaveLength(1);
      expect(beforeSnapshots[0].ctx.payload).toBe(input.requestPayload);
      expect(beforeSnapshots[0].ctx).toBe(afterSnapshots[0].ctx);
    });

    it('reports direct provider errors through ErrorErr02 capture hook and rethrows original error', async () => {
      const error = Object.assign(new Error('HTTP 502: upstream unavailable'), {
        statusCode: 502,
        code: 'HTTP_502',
      });
      const handle = createMockProviderHandle('openai-chat');
      (handle.instance.processIncomingDirect as jest.Mock).mockRejectedValueOnce(error);
      const onProviderError = jest.fn(async () => undefined);
      const requestPayload = { model: 'gpt-4', messages: [{ role: 'user', content: 'raw' }] };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-4' },
        requestPayload,
        requestId: 'req-router-direct-502',
        target: { providerKey: 'openai.gpt-4', providerType: 'openai', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'thinking', pool: ['openai.gpt-4', 'backup.gpt-4'] },
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
        onProviderError,
      };

      await expect(executeRouterDirectPipeline(input)).rejects.toBe(error);

      expect(onProviderError).toHaveBeenCalledTimes(1);
      const [source, ctx] = onProviderError.mock.calls[0] as any[];
      expect(source).toBe(error);
      expect(ctx.providerKey).toBe('openai.gpt-4');
      expect(handle.instance.processIncomingDirect).toHaveBeenCalledWith(requestPayload);
    });
  });

  describe('openai-responses protocol', () => {
    it('uses direct for openai-responses same-protocol routing and keeps payload untouched', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const requestPayload = {
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev_direct_router',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5', reasoning: { effort: 'high' } },
        requestPayload,
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'default' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(handle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
      expect(handle.instance.processIncomingDirect).toHaveBeenCalledWith(requestPayload);
    });

    it('skips when chat inbound targets responses provider', async () => {
      const handle = createMockProviderHandle('openai-responses');
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5' },
        requestPayload: { model: 'gpt-5.4' },
        target: { providerKey: 'tab.gpt-5', providerType: 'responses', runtimeKey: handle.runtimeKey },
        routingDecision: {},
        requestInfo: { path: '/v1/chat/completions', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(false);
      expect((result as any).reason).toContain('protocol mismatch');
      expect(result).not.toHaveProperty('requiresHubRelay');
    });

    it('uses direct for OpenAI Responses when protocols match', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
      } as ProviderHandle;
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-medium' },
        requestPayload: { model: 'gpt-5.4-medium', input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }] },
        target: { providerKey: 'openai.key4.gpt-5.4-medium', providerType: 'openai', runtimeKey: handle.runtimeKey },
        routingDecision: { routeName: 'thinking' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };
      const result = await executeRouterDirectPipeline(input);
      expect(result.used).toBe(true);
      expect(handle.instance.processIncomingDirect).toHaveBeenCalledTimes(1);
      expect(handle.instance.processIncomingDirect).toHaveBeenCalledWith({
        model: 'gpt-5.4-medium',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      });
      expect(handle.instance.processIncoming).not.toHaveBeenCalled();
    });

    it('does not normalize Responses input items before direct provider send', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
      } as ProviderHandle;
      const untypedUserItem = { role: 'user', content: [{ type: 'input_text', text: 'raw' }] };
      const requestPayload = {
        model: 'gpt-5.4-mini',
        input: [untypedUserItem],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-mini' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.4-mini',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.4-mini',
        },
        routingDecision: { routeName: 'thinking' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).toBe(requestPayload);
      expect((sentPayload.input as unknown[])[0]).toBe(untypedUserItem);
      expect(sentPayload).toEqual({
        model: 'gpt-5.4-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      });
    });

    it('preserves reasoning.summary on direct even when target model marks no_reasoning_summary', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        runtime: {
          modelCapabilities: {
            'gpt-5.3-codex-spark': ['text', 'reasoning', 'no_reasoning_summary'],
          },
        } as any,
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
        reasoning: { effort: 'high', summary: 'detailed' },
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.3-codex-spark' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.3-codex-spark',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.3-codex-spark',
        },
        routingDecision: { routeName: 'tools' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).not.toBe(requestPayload);
      expect(sentPayload.model).toBe('gpt-5.3-codex-spark');
      expect(sentPayload.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
      expect(requestPayload.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    });

    it('restores original client model on direct response after request model override', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'grok',
        providerFamily: 'grok',
      } as ProviderHandle;
      (handle.instance.processIncomingDirect as jest.Mock).mockImplementation(async (payload: Record<string, unknown>) => ({
        status: 200,
        body: {
          id: 'resp_direct_model_restore',
          object: 'response',
          status: 'completed',
          model: payload.model,
          output: [],
        },
      }));
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      };
      const result = await executeRouterDirectPipeline({
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'grok-build' },
        requestPayload,
        target: {
          providerKey: 'grok.key1.grok-build',
          providerType: 'responses',
          runtimeKey: handle.runtimeKey,
          modelId: 'grok-build',
        },
        routingDecision: { routeName: 'search' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      });

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload.model).toBe('grok-build');
      expect(result.auditContext.originalClientModel).toBe('gpt-5.5');
      expect((result.response as { body?: { model?: string } }).body?.model).toBe('gpt-5.5');
    });

    it('restores original client model on direct SSE response after request model override', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'grok',
        providerFamily: 'grok',
      } as ProviderHandle;
      (handle.instance.processIncomingDirect as jest.Mock).mockImplementation(async (payload: Record<string, unknown>) => ({
        status: 200,
        headers: { 'x-upstream-mode': 'sse' },
        sseStream: Readable.from([
          'event: response.created\n',
          `data: ${JSON.stringify({ type: 'response.created', response: { model: payload.model, status: 'in_progress' } })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({ type: 'response.completed', response: { model: payload.model, status: 'completed' } })}\n\n`,
        ]),
      }));
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      };
      const result = await executeRouterDirectPipeline({
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'grok-build' },
        requestPayload,
        target: {
          providerKey: 'grok.key1.grok-build',
          providerType: 'responses',
          runtimeKey: handle.runtimeKey,
          modelId: 'grok-build',
        },
        routingDecision: { routeName: 'search' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      });

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload.model).toBe('grok-build');
      expect(result.auditContext.originalClientModel).toBe('gpt-5.5');
      const response = result.response as { headers?: Record<string, string>; sseStream?: Readable };
      expect(response.headers?.['Content-Type'] || response.headers?.['content-type']).toMatch(/text\/event-stream/);
      const chunks: string[] = [];
      for await (const chunk of response.sseStream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      }
      const text = chunks.join('');
      expect(text).toContain('"model":"gpt-5.5"');
      expect(text).not.toContain('"model":"grok-build"');
    });

    it('preserves real image input on direct even when target lacks visual capability', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        runtime: {
          modelCapabilities: {
            'gpt-5.3-codex-spark': ['text', 'reasoning', 'no_reasoning_summary'],
          },
        } as any,
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.3-codex-spark' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.3-codex-spark',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.3-codex-spark',
        },
        routingDecision: { routeName: 'thinking' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).not.toBe(requestPayload);
      expect(sentPayload.model).toBe('gpt-5.3-codex-spark');
      expect(sentPayload.input).toEqual([{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      }]);
      expect(JSON.stringify(sentPayload)).toContain('data:image/png;base64,AAAA');
      expect(JSON.stringify(requestPayload)).toContain('data:image/png;base64,AAAA');
    });

    it('keeps real image input when direct target has visual capability', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        runtime: {
          modelCapabilities: {
            'gpt-5.4-mini': ['text', 'multimodal'],
          },
        } as any,
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.4-mini',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-mini' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.4-mini',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.4-mini',
        },
        routingDecision: { routeName: 'multimodal' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).toBe(requestPayload);
      expect(JSON.stringify(sentPayload)).toContain('data:image/png;base64,AAAA');
    });

    it('preserves protocol metadata fields before direct provider send', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'raw',
            metadata: { nested: 'must-not-leak' },
          }],
        }],
        client_metadata: {
          session_id: 'must-not-leak',
          'x-codex-turn-metadata': 'must-not-leak',
        },
        metadata: { request: 'must-not-leak' },
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.3-codex-spark' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.3-codex-spark',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.3-codex-spark',
        },
        routingDecision: { routeName: 'tools' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload).not.toBe(requestPayload);
      expect(sentPayload.model).toBe('gpt-5.3-codex-spark');
      expect(sentPayload.input).toEqual(requestPayload.input);
      expect(sentPayload.client_metadata).toEqual(requestPayload.client_metadata);
      expect(sentPayload.metadata).toEqual(requestPayload.metadata);
      expect(requestPayload.client_metadata.session_id).toBe('must-not-leak');
    });

    it('routes provider HTTP 403 response objects into direct provider error handling', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async () => ({
            status: 403,
            body: { error: { message: 'upstream denied' } },
          })),
        },
      } as ProviderHandle;
      const onProviderError = jest.fn(async () => {});
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-mini' },
        requestPayload: {
          model: 'gpt-5.5',
          stream: true,
          input: 'ping',
        },
        target: {
          providerKey: 'openai.key.gpt-5.4-mini',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.4-mini',
        },
        routingDecision: { routeName: 'thinking', pool: ['openai.key.gpt-5.4-mini'] },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
        onProviderError,
      };

      await expect(executeRouterDirectPipeline(input)).rejects.toMatchObject({
        status: 403,
        statusCode: 403,
        code: 'HTTP_403',
      });
      expect(onProviderError).toHaveBeenCalledTimes(1);
    });

    it('restores client model on direct response body after request-side model override', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        instance: {
          initialize: async () => {},
          cleanup: async () => {},
          processIncoming: jest.fn(),
          processIncomingDirect: jest.fn(async () => ({
            status: 200,
            body: {
              id: 'resp_router_direct_body_restore_model',
              model: 'gpt-5.3-codex-spark',
              output_text: 'ok',
            },
          })),
        },
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.3-codex-spark' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.3-codex-spark',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.3-codex-spark',
        },
        routingDecision: { routeName: 'thinking' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      // Request hook rewrote model to provider wire; response hook restores client model.
      expect(result.auditContext.originalClientModel).toBe('gpt-5.5');
      expect((result as any).response.body.model).toBe('gpt-5.5');
    });

    it('keeps reasoning.summary by default for direct responses target models', async () => {
      const handle = {
        ...createMockProviderHandle('openai-responses'),
        providerId: 'openai',
        providerFamily: 'openai',
        runtime: {
          modelCapabilities: {
            'gpt-5.4-mini': ['text', 'reasoning'],
          },
        } as any,
      } as ProviderHandle;
      const requestPayload = {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'raw' }] }],
        reasoning: { effort: 'high', summary: 'detailed' },
      };
      const input = {
        portConfig: createRouterPortConfig(),
        providerPayload: { model: 'gpt-5.4-mini' },
        requestPayload,
        target: {
          providerKey: 'openai.key.gpt-5.4-mini',
          providerType: 'openai',
          runtimeKey: handle.runtimeKey,
          modelId: 'gpt-5.4-mini',
        },
        routingDecision: { routeName: 'thinking' },
        requestInfo: { path: '/v1/responses', headers: {} },
        resolveProviderByRuntimeKey: () => handle,
      };

      const result = await executeRouterDirectPipeline(input);

      expect(result.used).toBe(true);
      const sentPayload = (handle.instance.processIncomingDirect as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sentPayload.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    });


  });
});
