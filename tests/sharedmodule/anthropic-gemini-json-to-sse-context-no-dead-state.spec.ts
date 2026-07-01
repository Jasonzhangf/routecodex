import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { AnthropicJsonToSseConverter } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/anthropic-json-to-sse-converter.js';
import { GeminiJsonToSseConverter } from '../../sharedmodule/llmswitch-core/src/sse/json-to-sse/gemini-json-to-sse-converter.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('Anthropic/Gemini JSON-to-SSE context dead-state boundary', () => {
  it('still projects Anthropic response events without converter-level context cache', async () => {
    const converter = new AnthropicJsonToSseConverter();
    const stream = await converter.convertResponseToJsonToSse({
      id: 'msg_anthropic_context_boundary',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1
      }
    } as any, {
      requestId: 'req_anthropic_context_boundary',
      model: 'claude-test'
    });

    const body = await readStreamBody(stream);

    expect(body).toContain('event: message_start');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('msg_anthropic_context_boundary');
  });

  it('still projects Gemini response events without converter-level context cache', async () => {
    const converter = new GeminiJsonToSseConverter();
    const stream = await converter.convertResponseToJsonToSse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }]
          },
          finishReason: 'STOP',
          index: 0
        }
      ]
    } as any, {
      requestId: 'req_gemini_context_boundary',
      model: 'gemini-test'
    });

    const body = await readStreamBody(stream);

    expect(body).toContain('event: gemini.data');
    expect(body).toContain('event: gemini.done');
    expect(body).toContain('hello');
  });

  it('does not keep Anthropic/Gemini converter-level context caches', () => {
    const files = [
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/anthropic-json-to-sse-converter.ts',
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/gemini-json-to-sse-converter.ts'
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('private contexts = new Map');
      expect(source).not.toContain('this.contexts.set(');
      expect(source).not.toContain('this.contexts.delete(');
    }
  });

  it('does not keep Anthropic/Gemini converter-level config defaults or constructor config injection', () => {
    const files = [
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/anthropic-json-to-sse-converter.ts',
      'sharedmodule/llmswitch-core/src/sse/json-to-sse/gemini-json-to-sse-converter.ts',
      'sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts',
      'sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.ts'
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('private config =');
      expect(source).not.toContain('constructor(config?');
      expect(source).not.toContain('this.config = { ...this.config, ...config }');
      expect(source).not.toContain('this.config.defaultChunkSize');
      expect(source).not.toContain('this.config.defaultDelayMs');
      expect(source).not.toContain('this.config.chunkDelayMs');
      expect(source).not.toContain('this.config.reasoningMode');
      expect(source).not.toContain('this.config.reasoningTextPrefix');
      expect(source).not.toContain('enableEventValidation: true');
      expect(source).not.toContain('strictMode: false');
      expect(source).not.toContain('enableStrictValidation: this.config.enableEventValidation');
      expect(source).not.toContain('DEFAULT_ANTHROPIC_CONVERSION_CONFIG');
      expect(source).not.toContain('DEFAULT_GEMINI_CONVERSION_CONFIG');
    }
  });
});
