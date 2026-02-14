import { Readable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { runRespInboundStage1SseDecode } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage1_sse_decode/index.js';

function createOpenAiChunk(delta: Record<string, unknown>, finishReason: string | null) {
  return JSON.stringify({
    id: 'chatcmpl-rewind-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'rewind-test-model',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  });
}

describe('resp_inbound stage1 SSE stream rewind', () => {
  it('keeps SSE payload intact when JSON pre-detection fails to parse', async () => {
    const ssePayload = [
      `data: ${createOpenAiChunk({ role: 'assistant', content: 'tool_calls:' }, null)}\n\n`,
      `data: ${createOpenAiChunk({ content: '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}' }, null)}\n\n`,
      `data: ${createOpenAiChunk({}, 'stop')}\n\n`,
      'data: [DONE]\n\n'
    ].join('');

    const result = await runRespInboundStage1SseDecode({
      providerProtocol: 'openai-chat',
      payload: {
        __sse_stream: Readable.from([ssePayload], { objectMode: false })
      } as any,
      adapterContext: { requestId: 'rewind-stage1-test' } as any,
      wantsStream: false
    });

    expect(result.decodedFromSse).toBe(true);
    const messageContent = String((result.payload as any)?.choices?.[0]?.message?.content || '');
    expect(messageContent).toContain('tool_calls');
    expect(messageContent).toContain('bd --no-db ready');
  });
});
