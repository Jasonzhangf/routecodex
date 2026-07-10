import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
    // Express compatibility no-op.
  }
}

describe('handler-response Responses SSE upstream incomplete regression', () => {
  const originalVerbose = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const originalStageLog = process.env.ROUTECODEX_STAGE_LOG;
  const originalStageVerbose = process.env.ROUTECODEX_STAGE_LOG_VERBOSE;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    process.env.ROUTECODEX_STAGE_LOG = '1';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';
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
  });

  it('does not synthesize incomplete errors when upstream Responses SSE ends before terminal event', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const upstream = new PassThrough();
    let output = '';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    res.on('data', (chunk) => {
      output += String(chunk);
    });

    try {
      const finished = new Promise<void>((resolve) => {
        res.on('finish', () => setTimeout(resolve, 0));
      });

      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true,
          },
        } as any,
        'req_responses_upstream_incomplete',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );

      upstream.write('event: response.created\n');
      upstream.write(
        'data: {"type":"response.created","response":{"id":"resp_incomplete","object":"response","status":"in_progress"}}\n\n'
      );
      upstream.write('event: response.output_item.added\n');
      upstream.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress"}}\n\n'
      );
      upstream.end();

      await finished;

      expect(output).toContain('event: response.created');
      expect(output).toContain('event: response.output_item.added');
      expect(output).not.toContain('event: error');
      expect(output).not.toContain('upstream_stream_incomplete');
      expect(output).not.toContain('event: response.completed');
      expect(output).not.toContain('event: response.done');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not project incomplete error when response.completed is split across chunks', async () => {
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));

    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const upstream = new PassThrough();
    let output = '';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    res.on('data', (chunk) => {
      output += String(chunk);
    });

    try {
      const finished = new Promise<void>((resolve) => {
        res.on('finish', () => setTimeout(resolve, 0));
      });

      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: upstream,
          metadata: {
            outboundStream: true,
            stream: true,
          },
        } as any,
        'req_responses_split_terminal',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );

      upstream.write('event: response.com');
      upstream.write('pleted\n');
      upstream.write(
        'data: {"type":"response.completed","response":{"id":"resp_done","object":"response","status":"completed"}}\n\n'
      );
      upstream.end();

      await finished;

      expect(output).toContain('event: response.completed');
      expect(output).toContain('"type":"response.completed"');
      expect(output).not.toContain('upstream_stream_incomplete');
      expect(output).not.toContain('event: error');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
