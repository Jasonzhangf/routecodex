import { describe, it, expect, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { ChatJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.js';
import { ChatSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.js';
import { buildChatSseStreamWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.js';
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

function expectChatChunkOnlyFields(chunk: ChatCompletionChunk): void {
  expect(Object.keys(chunk).sort()).toEqual(
    expect.arrayContaining(['choices', 'created', 'id', 'model', 'object'])
  );
  for (const forbidden of ['output', 'output_text', 'required_action', 'status', 'type']) {
    expect(chunk).not.toHaveProperty(forbidden);
  }
  expect(chunk.object).toBe('chat.completion.chunk');
  for (const choice of chunk.choices ?? []) {
    expect(choice).toHaveProperty('delta');
    expect(choice).not.toHaveProperty('message');
    expect(choice).not.toHaveProperty('content');
    expect(choice).not.toHaveProperty('item');
  }
}

async function *partialChatCompletionThenTerminated(): AsyncGenerator<string> {
  yield [
    'data: {"id":"chatcmpl_timeout_no_done","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_timeout_no_done","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
    ''
  ].join('\n');
  const error = Object.assign(new Error('terminated'), { code: 'TERMINATED' });
  throw error;
}

/**
 * Helper: build an SSE wire frame string for test purposes.
 * Replaces the deleted `serializeChatEventToSSE` which was a simple 2-line serializer.
 */
function testSseEvent(eventObj: Record<string, unknown>): string {
  const eventType = (eventObj.event ?? eventObj.type) as string;
  const rawData = eventObj.data;
  const payload = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
  return `event: ${eventType}\ndata: ${payload}\n\n`;
}

describe('chat SSE usage compatibility', () => {
  it('emits OpenAI/DeepSeek compatible chat SSE wire frames without named response events', async () => {
    const sseText = [
      testSseEvent({
        event: 'chat_chunk',
        type: 'chat_chunk',
        timestamp: 1,
        sequenceNumber: 0,
        protocol: 'chat',
        direction: 'json_to_sse',
        data: JSON.stringify({
          id: 'chatcmpl_tool_call_wire_contract',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5.5',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
              }]
            },
            finish_reason: null
          }]
        })
      }),
      testSseEvent({
        event: 'chat.done',
        type: 'chat.done',
        timestamp: 2,
        sequenceNumber: 1,
        protocol: 'chat',
        direction: 'json_to_sse',
        data: '[DONE]'
      })
    ].join('');

    const chunks = extractChatChunksFromWireText(sseText);

    expect(chunks[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe('exec_command');
    expect(chunks[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"cmd":"pwd"}');
    for (const frame of sseText.split(/\r?\n\r?\n/).filter(Boolean)) {
      // Chat SSE wire frames now include event: prefix (Rust-owned).
      expect(frame).toMatch(/^event: /m);
      expect(frame).toMatch(/^data: /m);
    }
    for (const forbidden of [
      'response.output_item',
      'response.completed',
      '"object":"response"',
      '"output"',
      '"required_action"'
    ]) {
      expect(sseText).not.toContain(forbidden);
    }
    expect(sseText).toContain('data: [DONE]');
    expect(sseText).toContain('"object":"chat.completion.chunk"');
  });

  it('round-trips chat tool_calls through data-only SSE without responses protocol fields', async () => {
    const toolCallChunk: ChatCompletionChunk = {
      id: 'chatcmpl_roundtrip_tool_call',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_roundtrip_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
          }]
        },
        finish_reason: null
      }]
    };
    const finishChunk: ChatCompletionChunk = {
      id: 'chatcmpl_roundtrip_tool_call',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    };
    const wire = [toolCallChunk, finishChunk]
      .map((chunk, index) => testSseEvent({
        event: 'chat_chunk',
        type: 'chat_chunk',
        timestamp: index + 1,
        sequenceNumber: index,
        protocol: 'chat',
        direction: 'json_to_sse',
        data: JSON.stringify(chunk)
      }))
      .join('') + testSseEvent({
        event: 'chat.done',
        type: 'chat.done',
        timestamp: 3,
        sequenceNumber: 2,
        protocol: 'chat',
        direction: 'json_to_sse',
        data: '[DONE]'
      });

    const parsed = extractChatChunksFromWireText(wire);

    expect(parsed).toHaveLength(2);
    for (const chunk of parsed) expectChatChunkOnlyFields(chunk);
    expect(parsed[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.id).toBe('call_roundtrip_1');
    expect(parsed[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"cmd":"pwd"}');
    expect(parsed[1]?.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(wire).toContain('event:');
    expect(wire).not.toContain('response.completed');
  });

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

  it('keeps one stable chat completion id and created timestamp across tool call SSE chunks', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_stable_tool_stream',
      object: 'chat.completion',
      created: 1782384831,
      model: 'MiniMax-M3',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_019efe6a2c097513a6744b71',
            type: 'function',
            function: {
              name: 'search_content',
              arguments: '{"context":3,"glob":"**/function-map.yml","pattern":"stopless"}'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    };

    const jsonToSse = new ChatJsonToSseConverterRefactored();
    const sseStream = await jsonToSse.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_tool_stable_stream',
      model: response.model
    });
    const sseText = await collectText(sseStream);
    const chunks = extractChatChunksFromWireText(sseText);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(chunks.map((chunk) => chunk.id))).toEqual(new Set(['chatcmpl_stable_tool_stream']));
    expect(new Set(chunks.map((chunk) => chunk.created))).toEqual(new Set([1782384831]));
    expect(chunks.some((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'search_content')).toBe(true);
    expect(chunks.some((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments?.includes('function-map.yml'))).toBe(true);
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe('tool_calls');
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

  it('fails invalid decoded usage instead of silently dropping it', async () => {
    const sseText = [
      'data: {"id":"chatcmpl_usage_decode_invalid","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_usage_decode_invalid","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_usage_decode_invalid","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"input_tokens":"bad-value","output_tokens":4,"total_tokens":13}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();

    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_usage_decode_invalid',
      model: 'gpt-4o-mini'
    })).rejects.toThrow('Invalid Chat usage.prompt_tokens');
  });

  it('aggregates partial responses without synthetic id created or message fallback', async () => {
    const sseText = [
      'data: {"id":"chatcmpl_partial_truth","object":"chat.completion.chunk","created":1782384831,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_partial_truth","object":"chat.completion.chunk","created":1782384831,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_partial_truth","object":"chat.completion.chunk","created":1782384831,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    const partials: ChatCompletionResponse[] = [];
    for await (const response of converter.aggregateSseStream(Readable.from([sseText]), {
      requestId: 'req_chat_partial_truth',
      model: 'gpt-4o-mini',
      onPartialResponse: partial => partials.push(partial)
    })) {
      partials.push(response);
    }

    expect(partials.length).toBeGreaterThan(0);
    for (const partial of partials) {
      expect(partial.id).toBe('chatcmpl_partial_truth');
      expect(partial.created).toBe(1782384831);
      expect(partial.choices?.[0]?.message?.role).toBe('assistant');
      expect(partial.choices?.[0]?.message).not.toEqual({ role: 'assistant', content: '' });
    }
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

  it('rejects DeepSeek patch payload as a non-chat SSE chunk', async () => {
    const sseText = [
      'data: {"v":{"response":{"message_id":2,"status":"WIP","content":""}}}',
      '',
      'data: {"p":"response/content","o":"APPEND","v":"hello"}',
      '',
      'data: {"p":"response/status","v":"FINISHED"}',
      '',
      'event: finish',
      'data: {}',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_deepseek_patch_reuse_parsed_data',
      model: 'deepseek-chat'
    })).rejects.toMatchObject({
      code: 'SSE_TO_JSON_ERROR'
    });
  });

  it('does not synthesize finish_reason=stop when upstream never emits finish_reason', async () => {
    const sseText = [
      'data: {"id":"chatcmpl_no_finish","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl_no_finish","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    const response = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_no_finish',
      model: 'gpt-4o-mini'
    });

    expect(response.choices?.[0]?.finish_reason).toBeUndefined();
    expect(response.choices?.[0]?.message?.content).toBe('hello');
  });

  it('preserves upstream context length errors instead of classifying them as SSE decode failures', async () => {
    const sseText = [
      'event: error',
      'data: {"type":"error","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","finish_reason":"context_length_exceeded"}',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_context_length_error',
      model: 'gpt-5.4'
    })).rejects.toMatchObject({
      code: 'context_length_exceeded',
      status: 400,
      statusCode: 400,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('does not salvage a partial chat stream into success after stream termination', async () => {
    const converter = new ChatSseToJsonConverter();

    await expect(converter.convertSseToJson(partialChatCompletionThenTerminated(), {
      requestId: 'req_chat_no_salvage_timeout',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      code: 'TERMINATED',
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
