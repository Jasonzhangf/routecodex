import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { sendPipelineResponse } from '../../../src/server/handlers/handler-utils.js';

describe('HTTP SSE stream timeout', () => {
  jest.setTimeout(10_000);

  const originalIdle = process.env.ROUTECODEX_HTTP_SSE_IDLE_TIMEOUT_MS;
  const originalTotal = process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_SSE_IDLE_TIMEOUT_MS = '50';
    process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = '500';
  });

  afterEach(() => {
    if (originalIdle === undefined) delete process.env.ROUTECODEX_HTTP_SSE_IDLE_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_IDLE_TIMEOUT_MS = originalIdle;
    if (originalTotal === undefined) delete process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_SSE_TIMEOUT_MS = originalTotal;
  });

  it('ends stalled SSE streams with an error event', async () => {
    const app = express();
    app.get('/sse', (_req, res) => {
      const stalled = new Readable({
        read() {
          // never push; simulates a hung upstream stream
        }
      });
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          headers: {},
          body: {
            __sse_responses: stalled
          }
        } as any,
        'req_test',
        { forceSSE: true }
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
      expect(text).toContain('HTTP_SSE_IDLE_TIMEOUT');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
