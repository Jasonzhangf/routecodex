import { describe, expect, it } from '@jest/globals';

import {
  buildJsonFromSseDirectNative,
  buildReadableFromSseFrames,
  buildSseFramesFromJsonDirectNative,
  collectSseBodyText,
} from './helpers/sse-direct-native.js';

describe('SSE unified Rust runtime dispatch direct native owner', () => {
  it('passes explicit protocol to native JSON to SSE dispatch without TS protocol fallback', () => {
    const result = buildSseFramesFromJsonDirectNative({
      protocol: 'openai-chat',
      requestId: 'req_chat_dispatch',
      model: 'gpt-test',
      response: {
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      },
    });

    const text = result.frames.join('');
    expect(text).toContain('chatcmpl_1');
    expect(text).toContain('data: [DONE]');
  });

  it('passes explicit protocol and raw body text to native SSE to JSON dispatch', () => {
    const result = buildJsonFromSseDirectNative({
      protocol: 'openai-responses',
      requestId: 'req_responses_dispatch',
      bodyText: 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","output":[]}}\n\n',
    });

    expect(result).toMatchObject({ id: 'resp_1', object: 'response' });
  });

  it('surfaces native unknown protocol errors instead of selecting a default protocol', () => {
    expect(() => buildJsonFromSseDirectNative({
      protocol: 'unknown-protocol',
      bodyText: '',
    })).toThrow(/Unsupported SSE protocol|invalid/i);
  });

  it('collects stream bytes and builds readable frames without protocol semantics', async () => {
    const body = await collectSseBodyText((async function* source() {
      yield Buffer.from('event: message\n');
      yield 'data: {"ok":true}\n\n';
    })());

    const readable = buildReadableFromSseFrames(['data: 1\n\n', 'data: [DONE]\n\n']);
    const chunks: string[] = [];
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    }

    expect(body).toBe('event: message\ndata: {"ok":true}\n\n');
    expect(chunks.join('')).toBe('data: 1\n\ndata: [DONE]\n\n');
  });
});
