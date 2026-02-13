import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { encodeClockClientApiKey } from '../../../src/utils/clock-client-token.js';

type MiddlewareMod = typeof import('../../../src/server/runtime/http-server/middleware.js');

async function startAppWithApiKey(apikey: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { registerApiKeyAuthMiddleware } = (await import('../../../src/server/runtime/http-server/middleware.js')) as MiddlewareMod;

  const app = express();
  registerApiKeyAuthMiddleware(app, { server: { apikey } } as any);

  app.get('/hello', (req, res) => {
    const daemonIdHeader =
      typeof req.headers['x-routecodex-clock-daemon-id'] === 'string'
        ? req.headers['x-routecodex-clock-daemon-id']
        : undefined;
    res.status(200).json({ ok: true, daemonIdHeader: daemonIdHeader || null });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    throw new Error('Failed to resolve ephemeral port');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('httpserver apikey env reference', () => {
  jest.setTimeout(10_000);

  it('accepts ${VAR} for httpserver.apikey', async () => {
    process.env.TEST_HTTP_APIKEY = 'dummy-http-apikey';
    const { baseUrl, close } = await startAppWithApiKey('${TEST_HTTP_APIKEY}');
    try {
      const denied = await fetch(`${baseUrl}/hello`);
      expect(denied.status).toBe(401);

      const ok = await fetch(`${baseUrl}/hello`, { headers: { 'x-api-key': 'dummy-http-apikey' } });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body?.daemonIdHeader).toBeNull();
    } finally {
      await close();
      delete process.env.TEST_HTTP_APIKEY;
    }
  });

  it('accepts daemon-suffixed apikey and exposes daemon hint header', async () => {
    process.env.TEST_HTTP_APIKEY = 'dummy-http-apikey';
    const { baseUrl, close } = await startAppWithApiKey('${TEST_HTTP_APIKEY}');
    try {
      const encoded = encodeClockClientApiKey('dummy-http-apikey', 'clockd_bind_1');
      const ok = await fetch(`${baseUrl}/hello`, { headers: { authorization: `Bearer ${encoded}` } });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body?.daemonIdHeader).toBe('clockd_bind_1');
    } finally {
      await close();
      delete process.env.TEST_HTTP_APIKEY;
    }
  });

  it('fails fast when env var missing', async () => {
    delete process.env.MISSING_HTTP_APIKEY;
    const { baseUrl, close } = await startAppWithApiKey('${MISSING_HTTP_APIKEY}');
    try {
      const res = await fetch(`${baseUrl}/hello`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(String(body?.error?.message || '')).toContain('MISSING_HTTP_APIKEY');
    } finally {
      await close();
    }
  });
});
