import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { getClientConnectionAbortSignal } from '../../../src/server/utils/client-connection-state.js';

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined
}));

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('responses-handler request timeout blackbox', () => {
  const previousTimeout = process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS = '80';
  });

  afterEach(() => {
    if (previousTimeout === undefined) delete process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS;
    else process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS = previousTimeout;
  });

  it('returns an SSE timeout error when stream=true executePipeline never resolves', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const app = express();
    let observedAbort = false;
    let observedAbortReason = '';
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: { metadata?: Record<string, unknown> }) => {
          const signal = getClientConnectionAbortSignal(input.metadata);
          signal?.addEventListener('abort', () => {
            observedAbort = true;
            const reason = (signal as { reason?: unknown }).reason;
            observedAbortReason = reason instanceof Error ? reason.message : String(reason ?? '');
          }, { once: true });
          return new Promise(() => undefined);
        },
        errorHandling: null,
      });
    });

    await withServer(app, async (baseUrl) => {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'timeout repro' }] }],
        }),
      });
      const text = await response.text();

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(response.status).toBe(504);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('HTTP_REQUEST_TIMEOUT');
      expect(observedAbort).toBe(true);
      expect(observedAbortReason).toContain('HTTP_REQUEST_TIMEOUT');
    });
  });

  it('does not time out a stream=true request when executePipeline resolves first', async () => {
    const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
    const app = express();
    let observedAbort = false;
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async (input: { metadata?: Record<string, unknown> }) => {
          const signal = getClientConnectionAbortSignal(input.metadata);
          signal?.addEventListener('abort', () => {
            observedAbort = true;
          }, { once: true });
          return {
            status: 200,
            headers: {},
            sseStream: Readable.from([
                'event: response.completed\n',
                'data: {"type":"response.completed","response":{"id":"resp_fast","object":"response","status":"completed","output":[]}}\n\n',
                'event: response.done\n',
                'data: {"type":"response.done","response":{"id":"resp_fast","object":"response","status":"completed","output":[]}}\n\n',
              ]),
            metadata: {},
          };
        },
        errorHandling: null,
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'fast path' }] }],
        }),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain('HTTP_REQUEST_TIMEOUT');
      expect(text).not.toContain('event: error');
      expect(observedAbort).toBe(false);
    });
  });

});
