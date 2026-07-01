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

async function expectStreamToReject(
  stream: AsyncIterable<unknown>,
  message: string
): Promise<void> {
  await expect(collectText(stream)).rejects.toThrow(message);
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

    await expectStreamToReject(stream, 'Invalid legacy function_call: missing arguments');
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

    await expectStreamToReject(stream, 'Invalid legacy function_call: missing id');
  });

  it('fails tool_calls without function arguments instead of emitting tool_call start and terminal frames', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_missing_tool_call_args',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_missing_args',
            type: 'function',
            function: {
              name: 'exec_command'
            }
          } as any]
        },
        finish_reason: 'tool_calls'
      }]
    };

    const converter = new ChatJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_tool_calls_missing_args',
      model: response.model
    });

    await expectStreamToReject(stream, 'Chat SSE tool call args delta payload missing arguments');
  });

  it('fails chunk delta without role instead of defaulting to assistant', async () => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl_delta_missing_role',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{
        index: 0,
        delta: {
          content: 'hello'
        },
        finish_reason: 'stop'
      } as any]
    };

    const converter = new ChatJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse(response, {
      requestId: 'req_chat_delta_missing_role',
      model: response.model
    });

    await expectStreamToReject(stream, 'Invalid ChatCompletionChunk delta: missing role');
  });
});
