import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { runHubPipelineLibWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';

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

function buildRequest(messages: StandardizedRequest['messages']): StandardizedRequest {
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
