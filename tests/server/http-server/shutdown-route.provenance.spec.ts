import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerDefaultMiddleware } from '../../../src/server/runtime/http-server/middleware.js';
import { registerHttpRoutes } from '../../../src/server/runtime/http-server/routes.js';

async function withShutdownServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  registerDefaultMiddleware(app, { server: { port: 0, host: '127.0.0.1' } } as any);
  registerHttpRoutes({
    app,
    config: { server: { port: 0, host: '127.0.0.1' } } as any,
    buildHandlerContext: () => ({}) as any,
    getPipelineReady: () => true,
    handleError: async () => {},
  } as any);

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

async function postShutdown(baseUrl: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const url = new URL('/shutdown', baseUrl);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function shutdownCallerHeaders(): Record<string, string> {
  return {
    'x-routecodex-stop-caller-pid': String(process.pid),
    'x-routecodex-stop-caller-ts': new Date().toISOString(),
    'x-routecodex-stop-caller-cwd': process.cwd(),
    'x-routecodex-stop-caller-cmd': process.argv.join(' '),
  };
}

describe('/shutdown caller provenance', () => {
  let killSpy: jest.SpiedFunction<typeof process.kill>;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('rejects anonymous localhost shutdown requests without terminating the process', async () => {
    await withShutdownServer(async (baseUrl) => {
      const response = await postShutdown(baseUrl);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'shutdown_caller_required' } });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  it('accepts shutdown requests that include cli caller provenance', async () => {
    await withShutdownServer(async (baseUrl) => {
      const response = await postShutdown(baseUrl, shutdownCallerHeaders());
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    });
  });
});
