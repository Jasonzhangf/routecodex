import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';
import { writeDaemonLoginRecord } from '../../../src/server/runtime/http-server/daemon-admin/auth-store.js';

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return () => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  };
}

function createTestConfig(port: number, apikey?: string, host = '127.0.0.1'): ServerConfigV2 {
  return {
    server: {
      host,
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

async function startTestServer(
  apikey?: string,
  host = '127.0.0.1'
): Promise<{ server: RouteCodexHttpServer; baseUrl: string; configDir: string; restoreEnv: () => void }> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-apikey-auth-'));
  const restoreEnvFns = [setEnv('ROUTECODEX_LOGIN_FILE', path.join(configDir, 'login'))];
  if (host === '0.0.0.0') {
    await writeDaemonLoginRecord('routecodex-test-password-123');
  }
  const restoreEnv = () => {
    for (const fn of restoreEnvFns.reverse()) {
      fn();
    }
  };
  const server = new RouteCodexHttpServer(createTestConfig(0, apikey, host));
  try {
    await server.start();
    const raw = (server as unknown as { server?: http.Server }).server;
    if (!raw) {
      throw new Error('Test server missing underlying http.Server');
    }
    const addr = raw.address() as AddressInfo | null;
    if (!addr || typeof addr.port !== 'number') {
      throw new Error('Failed to resolve server port');
    }
    return { server, baseUrl: `http://127.0.0.1:${addr.port}`, configDir, restoreEnv };
  } catch (error) {
    restoreEnv();
    try {
      await fs.rm(configDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

async function stopTestServer(server: RouteCodexHttpServer, configDir: string, restoreEnv: () => void): Promise<void> {
  await server.stop();
  restoreEnv();
  try {
    await fs.rm(configDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
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
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    try {
      const config = await getJson(baseUrl, '/config');
      expect(config.status).toBe(200);
      expect(config.body).toHaveProperty('httpserver');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('bypasses apikey when bind host is loopback', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer(expected);
    try {
      const config = await getJson(baseUrl, '/config');
      expect(config.status).toBe(200);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('requires apikey for non-health endpoints on non-loopback bind host', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer(expected, '0.0.0.0');
    try {
      const health = await getJson(baseUrl, '/health');
      expect(health.status).toBe(200);

      const adminUi = await getJson(baseUrl, '/daemon/admin');
      expect(adminUi.status).toBe(200);
      expect(String(adminUi.body)).toContain('<html');

      const denied = await getJson(baseUrl, '/config');
      expect(denied.status).toBe(401);

      const allowed = await getJson(baseUrl, '/config', { apikey: expected, authHeader: 'authorization' });
      expect(allowed.status).toBe(200);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('accepts Authorization: Bearer <apikey>', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer(expected, '0.0.0.0');
    try {
      const allowed = await getJson(baseUrl, '/config', { apikey: expected, authHeader: 'authorization' });
      expect(allowed.status).toBe(200);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('keeps /token-auth/demo reachable from localhost (for oauth portal)', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer(expected, '0.0.0.0');
    try {
      const portal = await getJson(baseUrl, '/token-auth/demo');
      expect(portal.status).toBe(200);
      expect(String(portal.body)).toContain('<html');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('keeps root entry reachable and redirects to daemon admin', async () => {
    const expected = 'test-apikey';
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer(expected, '0.0.0.0');
    try {
      const res = await fetch(`${baseUrl}/`, { method: 'GET', redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/daemon/admin');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });
});
