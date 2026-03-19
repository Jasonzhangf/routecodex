import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

  flushHeaders(): void {
    // no-op for tests
  }
}

describe('sendPipelineResponse SSE completion logging', () => {
  const originalVerbose = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const originalStageLog = process.env.ROUTECODEX_STAGE_LOG;
  const originalStageVerbose = process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
  const originalStageTiming = process.env.ROUTECODEX_STAGE_TIMING;
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    process.env.ROUTECODEX_STAGE_LOG = '1';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';
    delete process.env.ROUTECODEX_STAGE_TIMING;
    logSpy.mockClear();
    jest.resetModules();
  });

  afterAll(() => {
    if (originalVerbose === undefined) {
      delete process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_HTTP_LOG_VERBOSE = originalVerbose;
    }
    if (originalStageLog === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG;
    } else {
      process.env.ROUTECODEX_STAGE_LOG = originalStageLog;
    }
    if (originalStageVerbose === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_STAGE_LOG_VERBOSE = originalStageVerbose;
    }
    if (originalStageTiming === undefined) {
      delete process.env.ROUTECODEX_STAGE_TIMING;
    } else {
      process.env.ROUTECODEX_STAGE_TIMING = originalStageTiming;
    }
    logSpy.mockRestore();
  });

  it('logs finish_reason after streamed responses complete', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      writeSnapshotViaHooks: async () => undefined
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1010)
      .mockReturnValueOnce(1075)
      .mockReturnValueOnce(1080);

    const res = new MockResponse();
    const stream = Readable.from([
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"status":"requires_action","required_action":{"submit_tool_outputs":{"tool_calls":[]}}}}\n\n',
      'data: [DONE]\n\n'
    ]);

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream
        }
      } as any,
      'req-stream-finish',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('t+75ms'));
    expect(logSpy.mock.calls.filter((call) => String(call?.[0] ?? '').includes('[response.sse.stream][req-stream-finish] end'))).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[response][req-stream-finish] completed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b[97mfinish_reason=tool_calls\x1b[0m'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[response][req-stream-finish] completed t+0ms'));
  });

  it('logs client_close diagnostics when SSE closes before terminal event', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      writeSnapshotViaHooks: async () => undefined
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const stream = new PassThrough();

    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream
        }
      } as any,
      'req-stream-client-close',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.output_text.delta\n');
    stream.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    res.destroy();

    await closed;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[response.sse][req-stream-client-close] client_close'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"closeBeforeStreamEnd":true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sawTerminalEvent":false'));
  });
});
