import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  flushHeaders(): void {
    return undefined;
  }
}

async function importHandlerWithUsageMock(logUsageSummary: ReturnType<typeof jest.fn>) {
  jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/usage-logger.js', () => ({
    logUsageSummary
  }));
  jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
    isSnapshotsEnabled: () => false,
    writeServerSnapshot: async () => undefined
  }));
  return import('../../../src/server/handlers/handler-response-utils.js');
}

describe('sendPipelineResponse SSE usage logging', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('extracts streaming Anthropic usage before final usage log', async () => {
    const logUsageSummary = jest.fn();
    const { sendPipelineResponse } = await importHandlerWithUsageMock(logUsageSummary);

    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => resolve());
    });
    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
          'event: message_start\n',
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":7858,"output_tokens":1160,"cache_read_input_tokens":81024}}\n\n'
        ]),
        usageLogInfo: {
          requestStartedAtMs: Date.now(),
          providerKey: 'mimo.key2.mimo-v2.5',
          routeName: 'router-direct:tools',
          sessionId: 'sess-sse-usage-log'
        }
      } as any,
      'req-sse-usage-log',
      { entryEndpoint: '/v1/responses', forceSSE: true }
    );
    await finished;

    expect(logUsageSummary).toHaveBeenCalled();
    const usageArg = logUsageSummary.mock.calls.at(-1)?.[1] as any;
    expect(usageArg.usage).toMatchObject({
      prompt_tokens: 88882,
      completion_tokens: 1160,
      total_tokens: 90042,
      cache_read_input_tokens: 81024
    });
    expect(usageArg.sessionId).toBe('sess-sse-usage-log');
  });

  it('uses stream-completion elapsed external latency for direct SSE usage logs', async () => {
    const logUsageSummary = jest.fn();
    const { sendPipelineResponse } = await importHandlerWithUsageMock(logUsageSummary);
    const fixedNow = 1_700_000_000_000;
    const externalStartedAtMs = fixedNow - 5000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

    try {
      const res = new MockResponse();
      const finished = new Promise<void>((resolve) => {
        res.on('finish', () => resolve());
      });
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: Readable.from([
            'event: message_start\n',
            'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
            'event: message_delta\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":200}}\n\n'
          ]),
          usageLogInfo: {
            requestStartedAtMs: fixedNow,
            providerKey: 'mimo.key2.mimo-v2.5',
            routeName: 'router-direct:tools',
            sessionId: 'sess-sse-external-timing',
            externalLatencyStartedAtMs: externalStartedAtMs,
            externalLatencyMs: 0
          }
        } as any,
        'req-sse-external-timing',
        { entryEndpoint: '/v1/responses', forceSSE: true }
      );
      await finished;

      expect(logUsageSummary).toHaveBeenCalled();
      const usageArg = logUsageSummary.mock.calls.at(-1)?.[1] as any;
      expect(usageArg.externalLatencyMs).toBe(5000);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
