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

  it('replays the V2 direct passthrough SSE sample through shared Rust transport', async () => {
    const marker = 'direct-passthrough-sse-20260713T055458';
    const providerFrames = [
      'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"' + marker + '","object":"response","model":"gpt-test","status":"in_progress","reasoning":{"effort":"medium"},"output":[]}}\n\n',
      'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","response_id":"' + marker + '","delta":"PASSTHROUGH_SSE_OK"}\n\n',
      'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"' + marker + '","object":"response","model":"gpt-test","status":"completed","reasoning":{"effort":"medium"},"output":[{"type":"output_text","text":"PASSTHROUGH_SSE_OK"}]}}\n\n',
      'data: [DONE]\n\n',
    ];
    const clientFrames = [': keepalive\n\n', ...providerFrames];
    const providerBody = providerFrames.join('');
    const clientBody = await collectSseBodyText(buildReadableFromSseFrames(clientFrames));

    const replayed = buildJsonFromSseDirectNative({
      protocol: 'openai-responses',
      requestId: marker,
      model: 'gpt-test',
      bodyText: providerBody,
    });

    expect(replayed).toMatchObject({
      id: marker,
      object: 'response',
      model: 'gpt-test',
    });
    expect(JSON.stringify(replayed)).toContain('PASSTHROUGH_SSE_OK');
    expect(normalizeClientTransportKeepalive(clientBody)).toBe(providerBody);
    expect(providerBody).toContain('PASSTHROUGH_SSE_OK');
    expect(providerBody).toContain('data: [DONE]');
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

function normalizeClientTransportKeepalive(body: string): string {
  return body
    .split('\n\n')
    .filter((frame) => frame.trim() !== ': keepalive')
    .map((frame) => (frame.length > 0 ? frame + '\n\n' : ''))
    .join('');
}
