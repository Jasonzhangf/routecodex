import { describe, expect, it, jest } from '@jest/globals';

const nativeFunctions = new Map<string, (...args: unknown[]) => unknown>();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-shared.js',
  () => ({
    extractNativeErrorMessage: (raw: unknown) => {
      if (raw instanceof Error) return raw.message;
      if (raw && typeof raw === 'object' && 'message' in raw) {
        const message = (raw as { message?: unknown }).message;
        return typeof message === 'string' ? message : '';
      }
      return '';
    },
    failNative: <T>(capability: string, reason?: string): T => {
      throw new Error(`${capability} unavailable${reason ? `: ${reason}` : ''}`);
    },
    isNativeDisabledByEnv: () => false,
    readNativeFunction: (name: string) => nativeFunctions.get(name) ?? null,
  }),
);

const {
  buildJsonFromSseWithNative,
  buildReadableFromSseFrames,
  buildSseFramesFromJsonWithNative,
  collectSseBodyText,
} = await import('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.js');

describe('SSE unified Rust runtime dispatch bridge', () => {
  it('passes explicit protocol to native JSON to SSE dispatch without TS protocol fallback', () => {
    nativeFunctions.set('buildSseFramesFromJsonJson', (raw) => {
      const input = JSON.parse(String(raw));
      expect(input).toMatchObject({
        protocol: 'openai-chat',
        request_id: 'req_chat_dispatch',
        model: 'gpt-test',
      });
      return JSON.stringify({
        frames: ['data: {"id":"chatcmpl_1"}\n\n', 'data: [DONE]\n\n'],
        stats: { protocol: input.protocol },
      });
    });

    const result = buildSseFramesFromJsonWithNative({
      protocol: 'openai-chat',
      requestId: 'req_chat_dispatch',
      model: 'gpt-test',
      response: { id: 'chatcmpl_1', choices: [] },
    });

    expect(result.frames).toEqual(['data: {"id":"chatcmpl_1"}\n\n', 'data: [DONE]\n\n']);
    expect(result.stats).toEqual({ protocol: 'openai-chat' });
  });

  it('passes explicit protocol and raw body text to native SSE to JSON dispatch', () => {
    nativeFunctions.set('buildJsonFromSseJson', (raw) => {
      const input = JSON.parse(String(raw));
      expect(input).toMatchObject({
        protocol: 'openai-responses',
        body_text: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        request_id: 'req_responses_dispatch',
      });
      return JSON.stringify({ id: 'resp_1', object: 'response', output: [] });
    });

    const result = buildJsonFromSseWithNative({
      protocol: 'openai-responses',
      requestId: 'req_responses_dispatch',
      bodyText: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    });

    expect(result).toMatchObject({ id: 'resp_1', object: 'response' });
  });

  it('surfaces native unknown protocol errors instead of selecting a default protocol', () => {
    nativeFunctions.set('buildJsonFromSseJson', () => {
      throw new Error('Unsupported SSE protocol: unknown-protocol');
    });

    expect(() => buildJsonFromSseWithNative({
      protocol: 'unknown-protocol',
      bodyText: '',
    })).toThrow('Unsupported SSE protocol: unknown-protocol');
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
