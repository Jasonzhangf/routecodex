import { HubPipeline } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';

function buildVirtualRouterConfig(providerType: 'openai' | 'responses' = 'openai') {
  return {
    providers: {
      mock: {
        id: 'mock',
        enabled: true,
        type: providerType,
        baseURL: providerType === 'responses' ? 'mock://responses' : 'mock://openai',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [{ id: 'default-primary', targets: ['mock.gpt-test'] }]
    }
  };
}

function createPipeline(providerType: 'openai' | 'responses' = 'openai') {
  const artifacts = bootstrapVirtualRouterConfig({ virtualrouter: buildVirtualRouterConfig(providerType) } as any) as any;
  return new HubPipeline({
    virtualRouter: artifacts.config
  });
}

function createMemoryRoutingStateStore() {
  const stateMap = new Map<string, unknown>();
  return {
    stateMap,
    store: {
      loadSync: (key: string) => (stateMap.has(key) ? stateMap.get(key) : null),
      saveAsync: (key: string, state: unknown) => {
        if (!state) {
          stateMap.delete(key);
          return;
        }
        stateMap.set(key, state);
      },
      saveSync: (key: string, state: unknown) => {
        if (!state) {
          stateMap.delete(key);
          return;
        }
        stateMap.set(key, state);
      }
    }
  };
}

describe('HubPipeline passthrough audit', () => {
  test('activates passthrough from routing instruction and records audit snapshots', async () => {
    const pipeline = createPipeline();
    const result = await pipeline.execute({
      id: 'passthrough-audit-1',
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'dummy',
        messages: [{ role: 'user', content: '<**!mock.gpt-test:passthrough**>继续执行' }],
        tools: [],
        extra_field: 'inbound-extra'
      },
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        processMode: 'chat',
        routeHint: 'default',
        sessionId: 'sess-passthrough-audit-1'
      }
    });

    expect(result?.metadata?.processMode).toBe('passthrough');

    const audit = (result?.metadata as any)?.passthroughAudit;
    expect(audit).toBeDefined();
    expect(audit?.raw?.inbound?.extra_field).toBe('inbound-extra');
    expect(audit?.raw?.providerInput).toBeDefined();
    expect(audit?.todo?.inbound?.unmappedTopLevelKeys).toContain('extra_field');
    expect(audit?.todo?.governance?.skipped).toBe(true);
    expect(Array.isArray(audit?.todo?.outbound?.unmappedTopLevelKeys)).toBe(true);
  });

  test('keeps passthrough audit inbound/providerInput identical in dry-run', async () => {
    const pipeline = createPipeline();
    const payload = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello passthrough' }],
      tools: [],
      stream: false,
      temperature: 0.2,
      max_tokens: 16,
      metadata: { sample: 'ok' },
      extra_field: 'inbound-extra'
    };

    const result = await pipeline.execute({
      id: 'passthrough-audit-dryrun-1',
      endpoint: '/v1/chat/completions',
      payload: JSON.parse(JSON.stringify(payload)),
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        processMode: 'passthrough',
        routeHint: 'default',
        sessionId: 'sess-passthrough-audit-dryrun-1'
      }
    });

    expect(result?.metadata?.processMode).toBe('passthrough');
    const audit = (result?.metadata as any)?.passthroughAudit;
    expect(audit).toBeDefined();
    expect(audit?.raw?.inbound).toEqual(payload);
    expect(audit?.raw?.providerInput).toEqual(payload);
  });

  test('keeps /v1/responses payload shape unchanged in passthrough dry-run', async () => {
    const pipeline = createPipeline('responses');
    const payload = {
      model: 'gpt-test',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello passthrough responses' }] }],
      stream: true,
      tools: [{ type: 'function', name: 't1', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } }],
      tool_choice: 'auto',
      prompt_cache_key: 'k1',
      reasoning: { effort: 'medium' },
      extra_field: 'inbound-extra'
    };

    const result = await pipeline.execute({
      id: 'passthrough-audit-responses-dryrun-1',
      endpoint: '/v1/responses',
      payload: JSON.parse(JSON.stringify(payload)),
      metadata: {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        processMode: 'passthrough',
        routeHint: 'default',
        sessionId: 'sess-passthrough-audit-responses-dryrun-1'
      }
    });

    expect(result?.metadata?.processMode).toBe('passthrough');
    const audit = (result?.metadata as any)?.passthroughAudit;
    expect(audit).toBeDefined();
    expect(audit?.raw?.inbound).toEqual(payload);
    expect(audit?.raw?.providerInput).toEqual(payload);
    expect(result?.providerPayload).toEqual(payload);
  });

  test('throws on passthrough when target protocol differs', async () => {
    const pipeline = createPipeline('responses');
    await expect(
      pipeline.execute({
        id: 'passthrough-audit-3',
        endpoint: '/v1/chat/completions',
        payload: {
          model: 'dummy',
          messages: [{ role: 'user', content: '<**!mock.gpt-test:passthrough**>继续执行' }],
          tools: []
        },
        metadata: {
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          processMode: 'chat',
          routeHint: 'default',
          sessionId: 'sess-passthrough-audit-3'
        }
      })
    ).rejects.toThrow('passthrough requires matching protocols');
  });

  test('keeps regular chat mode when passthrough keyword is absent', async () => {
    const pipeline = createPipeline();
    const result = await pipeline.execute({
      id: 'passthrough-audit-2',
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'dummy',
        messages: [{ role: 'user', content: '<**!mock.gpt-test:unknown_mode**>继续执行' }],
        tools: []
      },
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        processMode: 'chat',
        routeHint: 'default',
        sessionId: 'sess-passthrough-audit-2'
      }
    });

    expect(result?.metadata?.processMode).toBe('chat');
    expect((result?.metadata as any)?.passthroughAudit).toBeUndefined();
  });

  test('propagates tmux scope into router metadata so stopMessage persists under tmux key', async () => {
    const routingState = createMemoryRoutingStateStore();
    const artifacts = bootstrapVirtualRouterConfig({ virtualrouter: buildVirtualRouterConfig('openai') } as any) as any;
    const pipeline = new HubPipeline({
      virtualRouter: artifacts.config,
      routingStateStore: routingState.store as any
    });
    const tmuxSessionId = 'rcc_tmux_scope_pipeline';

    await pipeline.execute({
      id: 'stopmessage-tmux-propagation-1',
      endpoint: '/v1/chat/completions',
      payload: {
        model: 'dummy',
        messages: [{ role: 'user', content: '<**stopMessage:"继续执行",2**>\n请继续处理任务' }],
        tools: []
      },
      metadata: {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        processMode: 'chat',
        routeHint: 'default',
        sessionId: 'session-should-not-be-used',
        clientTmuxSessionId: tmuxSessionId
      }
    });

    const persisted = routingState.stateMap.get(`tmux:${tmuxSessionId}`) as any;
    expect(persisted?.stopMessageText).toBe('继续执行');
    expect(persisted?.stopMessageMaxRepeats).toBe(2);
    expect(routingState.stateMap.has('session:session-should-not-be-used')).toBe(false);
  });
});
