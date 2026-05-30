import { describe, expect, it } from '@jest/globals';
import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';

class StubStageRecorder implements StageRecorder {
  public entries: Array<{ stage: string; payload: object }> = [];

  record(stage: string, payload: object): void {
    this.entries.push({ stage, payload });
  }
}

describe('provider response Rust native plan', () => {
  it('uses Rust HubPipeline native response plan for non-side-effect response path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native ok');
    expect(result.__sse_responses).toBeUndefined();
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: { effects: [] },
      diagnostics: expect.any(Array)
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage9.client_remap');
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage10.sse_stream');
  });
});
