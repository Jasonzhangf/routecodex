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

  it('raises SSE_DECODE_ERROR for deepseek toast error events', async () => {
    const ssePayload = [
      'event: ready\ndata: {"request_message_id":31,"response_message_id":32}\n\n',
      'event: finish\ndata: {}\n\n',
      'event: toast\ndata: {"type":"error","content":"达到对话长度上限，请开启新对话","finish_reason":"context_length_exceeded"}\n\n',
      'event: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n'
    ].join('');

    await expect(
      runRespInboundStage1SseDecode({
        providerProtocol: 'openai-chat',
        payload: {
          __sse_stream: Readable.from([ssePayload], { objectMode: false })
        } as any,
        adapterContext: {
          requestId: 'rewind-stage1-deepseek-toast',
          reqTokens: 1116403,
          target: { maxContextTokens: 512000 }
        } as any,
        wantsStream: false
      })
    ).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      details: {
        reason: 'context_length_exceeded',
        estimatedPromptTokens: 1116403,
        maxContextTokens: 512000
      }
    });
  });
});
