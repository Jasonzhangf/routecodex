import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { ChatJsonToSseConverterRefactored } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('chat JSON-to-SSE context dead-state boundary', () => {
  it('still projects a completed chat response without converter-level context cache', async () => {
    const converter = new ChatJsonToSseConverterRefactored();
    const stream = await converter.convertResponseToJsonToSse({
      id: 'chatcmpl_context_boundary',
      object: 'chat.completion',
      created: 1710000000,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          logprobs: null,
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2
      }
    } as any, {
      requestId: 'req_chat_context_boundary',
      model: 'gpt-test'
    });

    const body = await readStreamBody(stream);

    expect(body).toContain('data: [DONE]');
    expect(body).toContain('"id":"chatcmpl_context_boundary"');
  });

  it('does not keep converter-level context cache or active-context APIs', () => {
    const sourcePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('CONTEXT_TTL_MS');
    expect(source).not.toContain('MAX_CONTEXTS');
    expect(source).not.toContain('pruneChatContexts');
    expect(source).not.toContain('private contexts = new Map');
    expect(source).not.toContain('getActiveContexts(');
    expect(source).not.toContain('getContext(');
    expect(source).not.toContain('clearContext(');
  });
});
