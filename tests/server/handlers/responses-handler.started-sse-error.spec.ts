import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleResponses } from '../../../src/server/handlers/responses-handler.js';

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

describe('responses-handler SSE error projection regression', () => {
  it('keeps stream=true request on SSE error path even when client does not advertise Accept: text/event-stream', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async () => {
          throw Object.assign(new Error('Upstream rejected the request'), {
            code: 'bad_request_error',
            upstreamCode: 'bad_request_error',
            status: 400
          });
        },
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: '继续执行，若失败保持 SSE error event'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('bad_request_error');
      expect(text).not.toContain('{"error":');
    });
  });

  it('keeps started responses SSE stream on SSE error path instead of degrading to JSON', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/responses', async (req, res) => {
      await handleResponses(req as any, res as any, {
        executePipeline: async () => {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          (res as any).flushHeaders?.();
          throw Object.assign(new Error('Internal streaming failure after headers sent'), {
            code: 'INTERNAL_ERROR',
            upstreamCode: 'INTERNAL_ERROR',
            status: 500
          });
        },
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: '继续执行，若 started SSE 后失败也保持 SSE'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('INTERNAL_ERROR');
      expect(text).not.toContain('application/json');
      expect(text).not.toContain('{"error":');
    });
  });
});
