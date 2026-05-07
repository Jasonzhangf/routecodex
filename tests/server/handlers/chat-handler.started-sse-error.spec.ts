import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleChatCompletions } from '../../../src/server/handlers/chat-handler.js';

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

describe('chat-handler started SSE error propagation', () => {
  it('writes event:error when pipeline fails after SSE headers are already sent', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/chat/completions', async (req, res) => {
      await handleChatCompletions(req as any, res as any, {
        executePipeline: async () => {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          (res as any).flushHeaders?.();
          throw Object.assign(new Error('Upstream service temporarily unavailable'), {
            code: 'HTTP_502',
            status: 502,
            upstreamCode: 'HTTP_502'
          });
        },
        errorHandling: null
      });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: 'test-model',
          stream: true,
          messages: [{ role: 'user', content: '继续执行并在错误时返回 SSE error 事件' }]
        })
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: error');
      expect(text).toContain('HTTP_502');
      expect(text).toContain('Upstream service temporarily unavailable');
    });
  });
});
