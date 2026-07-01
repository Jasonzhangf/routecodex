import { describe, expect, it } from '@jest/globals';

import { ChatJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.js';
import type { ChatCompletionResponse } from '../../sharedmodule/llmswitch-core/src/sse/types/index.js';

async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
  }
  return chunks.join('');
}

describe('chat SSE usage no-fallback boundary', () => {
  it('omits missing usage instead of synthesizing a fallback usage block', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_usage',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }]
    };

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_missing_usage',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('"usage"');
  });

  it('fails invalid usage instead of silently dropping it', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_invalid_usage',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 'bad-value',
        completion_tokens: 1,
        total_tokens: 1
      }
    } as unknown as ChatCompletionResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_invalid_usage',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid Chat usage.prompt_tokens');
    expect(text).not.toContain('data: [DONE]');
  });

  it('rejects Responses-style usage aliases instead of normalizing them', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_response_usage_alias',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }],
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17
      }
    } as unknown as ChatCompletionResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_response_usage_alias',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid Chat usage: missing token fields');
    expect(text).not.toContain('data: [DONE]');
  });

  it('requires explicit total_tokens instead of deriving it from prompt and completion', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_total_usage',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5
      }
    } as unknown as ChatCompletionResponse;

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_missing_total_usage',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid Chat usage: missing token fields');
    expect(text).not.toContain('data: [DONE]');
  });

  it('requires explicit finish_reason instead of inferring stop from message content', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_finish_reason',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        }
      } as any]
    };

    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_missing_finish_reason',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid ChatCompletionResponse choice: missing finish_reason');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain('data: [DONE]');
  });
});
