import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  it('exposes context_window for provider-prefixed models from provider v2 configs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-models-context-window-'));
    const providerRoot = path.join(tmp, 'provider');
    const providerDir = path.join(providerRoot, 'deepseek-web');
    const restoreRccHome = process.env.RCC_HOME;
    process.env.RCC_HOME = tmp;
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      JSON.stringify(
        {
          version: '2.0.0',
          providerId: 'deepseek-web',
          provider: {
            id: 'deepseek-web',
            enabled: true,
            type: 'openai',
            baseURL: 'https://chat.deepseek.com',
            models: {
              'deepseek-reasoner': {
                supportsStreaming: true,
                maxContext: 750000,
                maxContextTokens: 750000
              }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const app = express();
    registerDefaultMiddleware(app, { server: { port: 5520, host: '127.0.0.1' } } as any);
    registerHttpRoutes({
      app,
      config: { server: { port: 5520, host: '127.0.0.1' } } as any,
      buildHandlerContext: () => ({}) as any,
      getPipelineReady: () => true,
      handleError: async () => {}
    });

    try {
      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        const body = await response.json();
        const target = Array.isArray(body?.data)
          ? body.data.find((item: any) => item?.id === 'deepseek-web.deepseek-reasoner')
          : null;
        expect(target).toBeTruthy();
        expect(target.context_window).toBe(750000);
      });
    } finally {
      if (restoreRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = restoreRccHome;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
