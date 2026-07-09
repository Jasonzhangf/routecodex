import { runHubPipelineLibWithNative } from '../sharedmodule/helpers/hub-pipeline-orchestration-direct-native.js';

type StandardizedRequest = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function runRequestPipeline(request: StandardizedRequest, metadata: Record<string, unknown>, requestId: string): StandardizedRequest {
  const preselectedRoute = {
    target: { providerKey: 'test.key1.gpt-test', modelId: 'gpt-test', outboundProfile: 'openai-chat' },
    decision: { routeName: 'test/preselected' },
    diagnostics: {},
  };
  const virtualRouter = {
    providers: {
      'test.key1.gpt-test': {
        providerKey: 'test.key1.gpt-test',
        providerType: 'openai',
        runtimeKey: 'test.key1',
        modelId: 'gpt-test',
        outboundProfile: 'openai-chat',
        enabled: true,
        endpoint: 'mock://test.key1',
        auth: { type: 'apikey', apiKey: 'test-key' },
      },
    },
    routing: {
      default: [{ id: 'default-priority', priority: 100, mode: 'priority', targets: ['test.key1.gpt-test'] }],
    },
  };
  const result = runHubPipelineLibWithNative({
    config: { virtualRouter, runtimeRouterRequired: false },
    request: {
      requestId,
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      payload: request as unknown as Record<string, unknown>,
      metadata: {
        ...metadata,
        runtime_control: {
          ...((metadata.runtime_control && typeof metadata.runtime_control === 'object' && !Array.isArray(metadata.runtime_control))
            ? metadata.runtime_control as Record<string, unknown>
            : {}),
          preselectedRoute,
        },
      },
      metadataCenterSnapshot: {
        requestTruth: {},
        continuationContext: {},
        runtimeControl: { preselectedRoute },
      },
      stream: false,
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
    },
  });
  if (result.success !== true) {
    throw new Error(result.error?.message ?? 'Rust HubPipeline request pipeline failed');
  }
  return result.payload as unknown as StandardizedRequest;
}

function buildRequest(): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'edit files' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'native placeholder',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input']
          }
        }
      } as any
    ],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('apply_patch provider-facing schema guidance', () => {
  test('aligns schema guidance with handler capabilities for weak-model compatibility', async () => {
    const processed = runRequestPipeline(
      buildRequest(),
      { originalEndpoint: '/v1/chat/completions', __rt: { applyPatch: { mode: 'servertool' } } },
      'req-apply-patch-schema-guidance',
    ) as any;
    const applyPatch = (processed.tools ?? []).find((tool: any) => (
      tool?.function?.name === 'apply_patch' || tool?.name === 'apply_patch'
    )) as any;
    expect(applyPatch).toBeTruthy();
    const definition = String(applyPatch.format?.definition || '');
    const description = String(applyPatch.function?.description || applyPatch.description || '');
    const patchDescription = String(applyPatch.function?.parameters?.properties?.patch?.description || definition);
    const schemaText = JSON.stringify(applyPatch);
    const guidanceText = `${definition}\n${description}\n${patchDescription}\n${schemaText}`;

    expect(applyPatch.type).toBe('custom');
    expect(guidanceText).toContain('*** Begin Patch');
    expect(guidanceText).toContain('*** End Patch');
    expect(schemaText).not.toContain('fileContent');
    expect(schemaText).not.toContain('cat');
    expect(schemaText).not.toContain('shell');
  });
});
