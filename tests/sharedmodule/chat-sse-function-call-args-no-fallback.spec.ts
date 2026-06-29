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

describe('chat SSE function_call arguments no-fallback boundary', () => {
  it('fails missing response id instead of using requestId as chunk id', async () => {
    const response: ChatCompletionResponse = {
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }]
    } as ChatCompletionResponse;

    const converter = new ChatJsonToSseConverterRefactored();

    await expect(converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_missing_response_id',
      model: response.model
    })).rejects.toThrow('Invalid ChatCompletionResponse: missing id');
  });

  it('fails missing response created timestamp instead of using current time', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_created',
      object: 'chat.completion',
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello'
        },
        finish_reason: 'stop'
      }]
    } as ChatCompletionResponse;

    const converter = new ChatJsonToSseConverterRefactored();

    await expect(converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_missing_response_created',
      model: response.model
    })).rejects.toThrow('Invalid ChatCompletionResponse: missing created timestamp');
  });

  it('fails legacy function_call with non-string arguments instead of stringifying them', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_bad_function_call_args',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          function_call: {
            id: 'call_bad_args',
            name: 'exec_command',
            arguments: { cmd: 'pwd' } as unknown as string
          } as any
        },
        finish_reason: 'function_call'
      }]
    };

    const converter = new ChatJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_function_call_args_no_fallback',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid legacy function_call: missing arguments');
    expect(text).not.toContain('"arguments":"{}"');
  });

  it('fails legacy function_call without an id instead of generating one', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_function_call_id',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          function_call: {
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}'
          } as any
        },
        finish_reason: 'function_call'
      }]
    };

    const converter = new ChatJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_function_call_missing_id',
      model: response.model
    });
    const text = await collectText(stream);

    expect(text).toContain('"code":"generation_error"');
    expect(text).toContain('Invalid legacy function_call: missing id');
  });
});
