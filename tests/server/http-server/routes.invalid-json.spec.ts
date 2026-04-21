import express from 'express';
import type { AddressInfo } from 'node:net';
import { registerDefaultMiddleware } from '../../../src/server/runtime/http-server/middleware.js';
import { registerHttpRoutes } from '../../../src/server/runtime/http-server/routes.js';

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

describe('http routes invalid json handling', () => {
  it('returns structured json instead of express html stack for malformed json bodies', async () => {
    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"deepseek-web.deepseek-chat","input":"bad\\escape"}'
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type') || '').toContain('application/json');
      const body = await response.json();
      expect(body?.error?.message).toContain('Bad escaped character');
      expect(body?.error?.code).toBe('MALFORMED_REQUEST');
    });
  });
});
