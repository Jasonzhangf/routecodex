import { HubPipeline } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';

function buildVirtualRouterConfig() {
  return {
    providers: {
      mock: {
        id: 'mock',
        enabled: true,
        type: 'openai',
        baseURL: 'mock://openai',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [{ id: 'default-primary', targets: ['mock.gpt-test'] }]
    }
  };
}

function createPipeline() {
  const artifacts = bootstrapVirtualRouterConfig({ virtualrouter: buildVirtualRouterConfig() } as any) as any;
  return new HubPipeline({
    virtualRouter: artifacts.config
  });
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
});
