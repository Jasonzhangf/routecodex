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

function buildRequest(messages: Array<Record<string, unknown>>): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages,
    tools: [],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('chat request marker strip', () => {
  test('strips any generic <**...**> marker syntax before request leaves chat process', async () => {
    const processed = runRequestPipeline(
      buildRequest([
        { role: 'user', content: 'a\n<**unknown:anything**>\nb\n<**clock:not-json**>\nc\n<**broken-marker' },
        { role: 'assistant', content: 'seen <**bad:marker**> too' }
      ]),
      { originalEndpoint: '/v1/chat/completions', tmuxSessionId: 'generic-marker-strip' },
      'req-generic-marker-strip',
    );
    const userContent = typeof processed.messages[0]?.content === 'string' ? processed.messages[0].content : '';
    const assistantContent = typeof processed.messages[1]?.content === 'string' ? processed.messages[1].content : '';

    expect(userContent).toContain('a');
    expect(userContent).toContain('b');
    expect(userContent).toContain('c');
    expect(userContent).not.toContain('<**');
    expect(assistantContent).not.toContain('<**');
  });

  test('does not leak routing markers (sm) into provider wire payload', async () => {
    const processed = runRequestPipeline(
      buildRequest([
        { role: 'user', content: '<**sm:30**>继续执行当前任务' }
      ]),
      { originalEndpoint: '/v1/chat/completions', sessionId: 'marker-keep-sm-30' },
      'req-marker-keep-sm-30',
    );
    const userContent = typeof processed.messages[0]?.content === 'string' ? processed.messages[0].content : '';

    expect(userContent).not.toContain('<**sm:30**>');
    expect(userContent).toContain('继续执行当前任务');
  });
});
