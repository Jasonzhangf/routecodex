import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

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
    const result = await runReqProcessStage1ToolGovernance({
      request: buildRequest([
        { role: 'user', content: 'a\n<**unknown:anything**>\nb\n<**clock:not-json**>\nc\n<**broken-marker' },
        { role: 'assistant', content: 'seen <**bad:marker**> too' }
      ]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', tmuxSessionId: 'generic-marker-strip' },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-generic-marker-strip'
    });
    const processed = result.processedRequest as StandardizedRequest;
    const userContent = typeof processed.messages[0]?.content === 'string' ? processed.messages[0].content : '';
    const assistantContent = typeof processed.messages[1]?.content === 'string' ? processed.messages[1].content : '';

    expect(userContent).toContain('a');
    expect(userContent).toContain('b');
    expect(userContent).toContain('c');
    expect(userContent).not.toContain('<**');
    expect(assistantContent).not.toContain('<**');
  });

  test('keeps routing markers (sm) for route stage consumption', async () => {
    const result = await runReqProcessStage1ToolGovernance({
      request: buildRequest([
        { role: 'user', content: '<**sm:30**>继续执行当前任务' }
      ]),
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId: 'marker-keep-sm-30' },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-marker-keep-sm-30'
    });
    const processed = result.processedRequest as StandardizedRequest;
    const userContent = typeof processed.messages[0]?.content === 'string' ? processed.messages[0].content : '';

    expect(userContent).toContain('<**sm:30**>');
  });
});
