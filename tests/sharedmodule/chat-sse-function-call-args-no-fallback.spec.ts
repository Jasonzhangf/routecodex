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
  it('fails cyclic legacy function_call arguments instead of serializing them as empty JSON', async () => {
    const cyclic: Record<string, unknown> = { cmd: 'pwd' };
    cyclic.self = cyclic;

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
            name: 'exec_command',
            arguments: cyclic as unknown as string
          }
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
    expect(text).toContain('Converting circular structure to JSON');
    expect(text).not.toContain('"arguments":"{}"');
  });
});
