import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

describe('HTTP SSE stream timeout', () => {
  jest.setTimeout(10_000);

  const originalTotal = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '50';
  });

  afterEach(() => {
    if (originalTotal === undefined) delete process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = originalTotal;
  });

  it('ends stalled SSE streams with an error event', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      deriveFinishReasonNative: () => undefined,
      projectSseErrorEventPayloadNative: (args: { requestId?: string; status?: number; message?: string; code?: string }) => ({
        type: 'error',
        request_id: args.requestId,
        status: args.status ?? 500,
        message: args.message ?? 'sse error',
        code: args.code ?? 'ERR_SSE_ERROR',
      }),
      writeSnapshotViaHooks: async () => undefined,
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const app = express();
    app.get('/sse', (_req, res) => {
      const stalled = new Readable({
        read() {
          // never push; simulates a hung upstream stream
        }
      });
      stalled.on('error', () => {});
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          sseStream: stalled,
        } as any,
        'req_test',
        { forceSSE: true, sseTotalTimeoutMs: 50 }
      );
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/sse`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' }
      });
      const text = await response.text();
      expect(text).toContain('event: error');
      expect(text).toContain('HTTP_SSE_TIMEOUT');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
