import { describe, it, expect } from '@jest/globals';
import { Readable } from 'node:stream';
import { ChatJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.js';
import { ChatSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.js';
import type { ChatCompletionChunk, ChatCompletionResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
  }
  return chunks.join('');
}

function extractChatChunksFromWireText(sseText: string): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];
  const frames = sseText.split(/\r?\n\r?\n/).map((frame) => frame.trim()).filter(Boolean);
  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    const dataText = dataLines.join('\n').trim();
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    const payload = JSON.parse(dataText) as ChatCompletionChunk;
    if (payload?.object === 'chat.completion.chunk') {
      chunks.push(payload);
    }
  }
  return chunks;
}

describe('chat SSE usage compatibility', () => {
  it('emits standard usage in the final chat completion chunk', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_usage_final_chunk',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello world'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20
      }
    };

    const jsonToSse = new ChatJsonToSseConverterRefactored();
    const sseStream = await jsonToSse.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_usage_final_chunk',
      model: response.model
    });
    const sseText = await collectText(sseStream);
    const chunks = extractChatChunksFromWireText(sseText);
    const finishChunk = chunks.find((chunk) =>
      chunk.choices?.some((choice) => choice.finish_reason === 'stop')
    );

    expect(finishChunk).toBeDefined();
    expect(finishChunk?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20
    });
  });

  it('preserves final chunk usage when converting chat SSE back to JSON', async () => {
    const sseText = [
      'data: {"id":"chatcmpl_usage_parse","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_usage_parse","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_usage_parse","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_usage_parse',
      model: 'gpt-4o-mini'
    });

    expect(response.choices).toHaveLength(1);
    expect(response.choices?.[0]?.finish_reason).toBe('stop');
    expect(response.choices?.[0]?.message?.content).toBe('hello');
    expect(response.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13
    });
  });

  it('round-trips reasoning_content from chat SSE outbound/inbound mapping', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_reasoning_roundtrip',
      object: 'chat.completion',
      created: 1,
      model: 'qwen3.6-plus',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: '先检查上下文，再继续执行'
        },
        finish_reason: 'stop'
      }]
    };

    const jsonToSse = new ChatJsonToSseConverterRefactored();
    const sseStream = await jsonToSse.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_reasoning_roundtrip',
      model: response.model
    });
    const sseText = await collectText(sseStream);
    expect(sseText).toContain('"reasoning_content":"先检查上下文，再继续执行"');

    const converter = new ChatSseToJsonConverter();
    const parsed = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_reasoning_roundtrip',
      model: response.model
    });

    expect(parsed.choices?.[0]?.message?.reasoning_content).toBe('先检查上下文，再继续执行');
  });
});
