import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

describe('sendPipelineResponse usage log tag forwarding', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  async function importHandlerWithUsageMock(logUsageSummary: ReturnType<typeof jest.fn>) {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/usage-logger.js', () => ({
      logUsageSummary
    }));
    return import('../../../src/server/handlers/handler-response-utils.js');
  }

  it('forwards providerDecodeTag into logUsageSummary', async () => {
    const logUsageSummary = jest.fn();
    const { sendPipelineResponse } = await importHandlerWithUsageMock(logUsageSummary);

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: 'resp_usage_tag',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }]
            }
          ]
        },
        usageLogInfo: {
          requestStartedAtMs: Date.now() - 10,
          finishReason: 'stop',
          providerDecodeTag: 'provider-a.nonstream=json',
          usage: {
            input_tokens: 1,
            output_tokens: 1
          }
        }
      } as any,
      'req-usage-tag-forward',
      { entryEndpoint: '/v1/responses' }
    );

    expect(logUsageSummary).toHaveBeenCalledTimes(1);
    expect(logUsageSummary.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        providerDecodeTag: 'provider-a.nonstream=json'
      })
    );
  });

  it('keeps provided externalLatencyMs for JSON responses', async () => {
    const logUsageSummary = jest.fn();
    const { sendPipelineResponse } = await importHandlerWithUsageMock(logUsageSummary);
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

    try {
      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: {
            id: 'resp_usage_json_timing',
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }]
              }
            ]
          },
          usageLogInfo: {
            requestStartedAtMs: fixedNow - 10,
            providerKey: 'mimo.key2.mimo-v2.5',
            routeName: 'router-direct:tools',
            externalLatencyStartedAtMs: fixedNow - 5000,
            externalLatencyMs: 1234
          }
        } as any,
        'req-usage-json-timing',
        { entryEndpoint: '/v1/responses' }
      );

      expect(logUsageSummary).toHaveBeenCalledTimes(1);
      expect(logUsageSummary.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          externalLatencyMs: 1234
        })
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
