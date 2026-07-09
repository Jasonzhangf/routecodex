import { runHubPipelineLibWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

type StandardizedRequest = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function runRequestPipeline(request: StandardizedRequest, metadata: Record<string, unknown>, requestId: string): StandardizedRequest {
  const result = runHubPipelineLibWithNative({
    config: { virtualRouter: {} },
    request: {
      requestId,
      endpoint: '/v1/chat/completions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      payload: request as unknown as Record<string, unknown>,
      metadata: {
        ...metadata,
        __routecodexPreselectedRoute: {
          target: { providerKey: 'test.key1.gpt-test', modelId: 'gpt-test', outboundProfile: 'openai-chat' },
          decision: { routeName: 'test/preselected' },
          diagnostics: {},
        },
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
    const applyPatch = (processed.tools ?? []).find((tool: any) => tool?.function?.name === 'apply_patch') as any;
    expect(applyPatch).toBeTruthy();
    const description = String(applyPatch.function.description || '');
    const patchDescription = String(applyPatch.function.parameters.properties.patch?.description || '');
    const schemaText = JSON.stringify(applyPatch);

    expect(applyPatch.function.parameters.required).toContain('patch');
    expect(description || patchDescription || schemaText).toContain('*** Begin Patch');
    expect(description || patchDescription || schemaText).toContain('workspace-relative');
    expect(schemaText).not.toContain('fileContent');
    expect(schemaText).not.toContain('cat');
    expect(schemaText).not.toContain('shell');
  });
});
