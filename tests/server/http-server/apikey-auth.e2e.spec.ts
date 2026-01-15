import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

function createTestConfig(port: number, apikey?: string): ServerConfigV2 {
  return {
    server: {
      host: '127.0.0.1',
      port,
      apikey
    },
    pipeline: {},
    logging: {
      level: 'error',
      enableConsole: false
    },
    providers: {}
  };
}

async function startTestServer(apikey?: string): Promise<{ server: RouteCodexHttpServer; baseUrl: string }> {
  const server = new RouteCodexHttpServer(createTestConfig(0, apikey));
  await server.start();
  const raw = (server as unknown as { server?: http.Server }).server;
  if (!raw) {
    throw new Error('Test server missing underlying http.Server');
  }
  const addr = raw.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    throw new Error('Failed to resolve server port');
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function stopTestServer(server: RouteCodexHttpServer): Promise<void> {
  await server.stop();
}

async function getJson(
  baseUrl: string,
  path: string,
  opts?: { apikey?: string; authHeader?: 'x-api-key' | 'authorization' }
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  if (opts?.apikey) {
    if (opts.authHeader === 'authorization') {
      headers.set('authorization', `Bearer ${opts.apikey}`);
    } else {
      headers.set('x-api-key', opts.apikey);
    }
  }
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('HTTP apikey auth (optional)', () => {
  jest.setTimeout(30000);

  it('allows requests when apikey not configured', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const config = await getJson(baseUrl, '/config');
      expect(config.status).toBe(200);
      expect(config.body).toHaveProperty('httpserver');
    } finally {
      await stopTestServer(server);
    }
  });

  it('requires apikey for non-health endpoints when configured', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl } = await startTestServer(expected);
    try {
      const health = await getJson(baseUrl, '/health');
      expect(health.status).toBe(200);

      const denied = await getJson(baseUrl, '/config');
      expect(denied.status).toBe(401);

      const allowed = await getJson(baseUrl, '/config', { apikey: expected });
      expect(allowed.status).toBe(200);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts Authorization: Bearer <apikey>', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl } = await startTestServer(expected);
    try {
      const allowed = await getJson(baseUrl, '/config', { apikey: expected, authHeader: 'authorization' });
      expect(allowed.status).toBe(200);
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps /token-auth/demo reachable from localhost (for oauth portal)', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl } = await startTestServer(expected);
    try {
      const portal = await getJson(baseUrl, '/token-auth/demo');
      expect(portal.status).toBe(200);
      expect(String(portal.body)).toContain('<html');
    } finally {
      await stopTestServer(server);
    }
  });
});

