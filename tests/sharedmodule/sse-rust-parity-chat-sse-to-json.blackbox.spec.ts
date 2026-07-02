import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import { Readable } from 'node:stream';

import { ChatSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.js';

function chatChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function doneFrame(): string {
  return 'data: [DONE]\n\n';
}

async function decode(sseText: string) {
  const converter = new ChatSseToJsonConverter();
  return converter.convertSseToJson(Readable.from([sseText]), {
    requestId: 'req_chat_sse_decode_parity',
    model: 'gpt-test',
    reasoningMode: 'channel'
  });
}

describe('chat SSE to JSON Rust parity boundary', () => {
  it('aggregates standard OpenAI chat chunks into one final response', async () => {
    const response = await decode([
      chatChunk({
        id: 'chatcmpl_decode_text',
        object: 'chat.completion.chunk',
        created: 1781149600,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      }),
      chatChunk({
        id: 'chatcmpl_decode_text',
        object: 'chat.completion.chunk',
        created: 1781149600,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }]
      }),
      chatChunk({
        id: 'chatcmpl_decode_text',
        object: 'chat.completion.chunk',
        created: 1781149600,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }]
      }),
      doneFrame()
    ].join(''));

    expect(response).toMatchObject({
      id: 'chatcmpl_decode_text',
      object: 'chat.completion',
      created: 1781149600,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello world' },
          finish_reason: 'stop'
        }
      ]
    });
    expect(JSON.stringify(response)).not.toContain('metadata');
    expect(JSON.stringify(response)).not.toContain('__rt');
  });

  it('preserves usage from the final usage-bearing chunk', async () => {
    const response = await decode([
      chatChunk({
        id: 'chatcmpl_decode_usage',
        object: 'chat.completion.chunk',
        created: 1781149601,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
      }),
      chatChunk({
        id: '',
        object: 'chat.completion.chunk',
        created: 0,
        model: '',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
      }),
      doneFrame()
    ].join(''));

    expect(response.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('aggregates tool call argument deltas exactly', async () => {
    const response = await decode([
      chatChunk({
        id: 'chatcmpl_decode_tool',
        object: 'chat.completion.chunk',
        created: 1781149602,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_decode_tool',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"' }
            }]
          },
          finish_reason: null
        }]
      }),
      chatChunk({
        id: 'chatcmpl_decode_tool',
        object: 'chat.completion.chunk',
        created: 1781149602,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'pwd"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      doneFrame()
    ].join(''));

    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    expect(response.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_decode_tool',
        type: 'function',
        function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
      }
    ]);
  });

  it('aggregates legacy function_call deltas when upstream still emits them', async () => {
    const response = await decode([
      chatChunk({
        id: 'chatcmpl_decode_function',
        object: 'chat.completion.chunk',
        created: 1781149603,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: { role: 'assistant', function_call: { name: 'legacy_call', arguments: '{"a":' } },
          finish_reason: null
        }]
      }),
      chatChunk({
        id: 'chatcmpl_decode_function',
        object: 'chat.completion.chunk',
        created: 1781149603,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: { function_call: { arguments: '1}' } },
          finish_reason: 'function_call'
        }]
      }),
      doneFrame()
    ].join(''));

    expect(response.choices[0]?.finish_reason).toBe('function_call');
    expect(response.choices[0]?.message.function_call).toEqual({
      name: 'legacy_call',
      arguments: '{"a":1}'
    });
  });

  it('fails incomplete streams instead of silently completing without terminal truth', async () => {
    await expect(decode([
      chatChunk({
        id: 'chatcmpl_decode_incomplete',
        object: 'chat.completion.chunk',
        created: 1781149604,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }]
      })
    ].join(''))).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails malformed chunks after valid content instead of returning partial success', async () => {
    await expect(decode([
      chatChunk({
        id: 'chatcmpl_decode_malformed_tail',
        object: 'chat.completion.chunk',
        created: 1781149605,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'valid' }, finish_reason: null }]
      }),
      'data: {"id":"chatcmpl_decode_malformed_tail"\n\n',
      doneFrame()
    ].join(''))).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('keeps Chat SSE decode converter as a native-backed IO shell', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts',
      'utf8'
    );

    expect(source).toContain('buildChatJsonFromSseWithNative');
    expect(source).not.toContain('processSseEvent(');
    expect(source).not.toContain('finalizeResponse(');
    expect(source).not.toContain('normalizeMessageReasoningTools');
    expect(source).not.toContain('normalizeChatMessageContent');
    expect(source).not.toContain('dispatchReasoning');
  });
});
