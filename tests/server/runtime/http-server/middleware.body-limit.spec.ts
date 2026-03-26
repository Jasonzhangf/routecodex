import express from 'express';
import type { AddressInfo } from 'node:net';
import { registerDefaultMiddleware } from '../../../../src/server/runtime/http-server/middleware.js';

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('http server middleware body limit', () => {
  it('uses configured bodyLimit when provided', async () => {
    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5555, host: '127.0.0.1', bodyLimit: '1kb' } } as any);
    app.post('/echo', (req, res) => res.status(200).json({ ok: true, size: JSON.stringify(req.body).length }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(2 * 1024) })
      });
      expect(response.status).toBe(413);
    });
  });

  it('defaults to 64mb so >10mb payloads still parse', async () => {
    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5555, host: '127.0.0.1' } } as any);
    app.post('/echo', (req, res) => res.status(200).json({ ok: true, size: String(req.body?.text || '').length }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(11 * 1024 * 1024) })
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.size).toBe(11 * 1024 * 1024);
    });
  });
});
