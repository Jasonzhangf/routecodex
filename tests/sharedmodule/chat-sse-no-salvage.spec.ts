import { describe, expect, it } from '@jest/globals';
import { Readable } from 'node:stream';

import { ChatSseToJsonConverter } from '../../sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.js';

describe('chat SSE no-salvage boundary', () => {
  it('does not salvage mixed-line chat_chunk payloads into a successful response', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_no_salvage","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
      'data: not-json',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_no_salvage_mixed_lines',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails fast on malformed chat.done payloads instead of swallowing parse errors', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_done_parse","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":null}]}',
      '',
      'event: chat.done',
      'data: {"totalTokens":',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_done_parse_error',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails fast on malformed chat.error payloads instead of keeping raw payload only', async () => {
    const sseText = [
      'event: error',
      'data: {"type":"error","message":',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_error_parse_error',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails chat chunks missing upstream id instead of generating one from requestId', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_missing_id_no_synthetic',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails chat chunks missing created timestamp instead of using current time', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_missing_created","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_missing_created_no_synthetic',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('fails chat chunks missing role instead of defaulting to assistant', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_missing_role","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_missing_role_no_synthetic',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });

  it('normalizes chat usage through native owner instead of local TS helper semantics', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_usage_native","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","usage":{"input_tokens":12,"output_tokens":5,"prompt_cache_hit_tokens":3},"choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    const output = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_usage_native_owner',
      model: 'gpt-4o-mini'
    });

    expect(output.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 3 }
    });
  });

  it('allows inert tail chunks after a valid response is established instead of failing on empty terminal noise', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"chatcmpl_tail_noise","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"logprobs":null,"finish_reason":"stop"}]}',
      '',
      'event: chat_chunk',
      'data: {"id":"","object":"","created":0,"model":"gpt-4o-mini","choices":[],"usage":null}',
      '',
      'event: chat_chunk',
      'data: {"id":"","object":"chat.completion.chunk","created":0,"model":"","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    const output = await converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_tail_noise_after_valid_chunk',
      model: 'gpt-4o-mini'
    });

    expect(output.id).toBe('chatcmpl_tail_noise');
    expect(output.model).toBe('gpt-4o-mini');
    expect(output.choices[0]?.message?.content).toContain('hello');
    expect(output.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17
    });
  });

  it('still fails when the first chunk has empty id and no established response context', async () => {
    const sseText = [
      'event: chat_chunk',
      'data: {"id":"","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
      '',
      'event: chat.done',
      'data: [DONE]',
      ''
    ].join('\n');

    const converter = new ChatSseToJsonConverter();
    await expect(converter.convertSseToJson(Readable.from([sseText]), {
      requestId: 'req_chat_first_chunk_empty_id',
      model: 'gpt-4o-mini'
    })).rejects.toMatchObject({
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
