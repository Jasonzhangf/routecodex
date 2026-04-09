import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public jsonBody: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.jsonBody = body;
    this.end(JSON.stringify(body));
    return this;
  }
}

describe('sendPipelineResponse chat usage normalization', () => {
  it('normalizes chat usage shape from input/output tokens', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'chatcmpl_test_usage',
          object: 'chat.completion',
          choices: [],
          usage: {
            input_tokens: 12,
            output_tokens: 8
          }
        }
      } as any,
      'req-chat-usage-shape',
      { entryEndpoint: '/v1/chat/completions' }
    );

    const json = res.jsonBody as Record<string, unknown>;
    const usage = json.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(8);
    expect(usage.prompt_tokens).toBe(12);
    expect(usage.completion_tokens).toBe(8);
    expect(usage.total_tokens).toBe(20);
  });

  it('backfills input/output aliases when provider returns prompt/completion usage', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'chatcmpl_test_usage_prompt_completion_only',
          object: 'chat.completion',
          choices: [],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 9,
            total_tokens: 51
          }
        }
      } as any,
      'req-chat-usage-prompt-completion-shape',
      { entryEndpoint: '/v1/chat/completions' }
    );

    const json = res.jsonBody as Record<string, unknown>;
    const usage = json.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(42);
    expect(usage.completion_tokens).toBe(9);
    expect(usage.total_tokens).toBe(51);
    expect(usage.input_tokens).toBe(42);
    expect(usage.output_tokens).toBe(9);
  });

  it('injects normalized chat usage from usageLogInfo fallback when body usage is missing', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'chatcmpl_test_usage_fallback',
          object: 'chat.completion',
          choices: []
        },
        usageLogInfo: {
          requestStartedAtMs: Date.now(),
          usage: {
            input_tokens: 99,
            output_tokens: 21
          }
        }
      } as any,
      'req-chat-usage-fallback',
      { entryEndpoint: '/v1/chat/completions' }
    );

    const json = res.jsonBody as Record<string, unknown>;
    const usage = json.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(99);
    expect(usage.completion_tokens).toBe(21);
    expect(usage.total_tokens).toBe(120);
    expect(usage.input_tokens).toBe(99);
    expect(usage.output_tokens).toBe(21);
  });

  it('does not emit custom usage header for chat SSE responses', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => resolve());
    });
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: Readable.from([
            'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
            'data: [DONE]\n\n'
          ]),
          usage: {
            input_tokens: 30,
            output_tokens: 7
          }
        }
      } as any,
      'req-chat-usage-stream-header',
      { entryEndpoint: '/v1/chat/completions', forceSSE: true }
    );
    await finished;

    expect(res.headers.get('x-routecodex-usage')).toBeUndefined();
  });
});
