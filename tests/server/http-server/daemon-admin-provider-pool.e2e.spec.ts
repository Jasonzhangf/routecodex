import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Started = { baseUrl: string; stop: () => Promise<void> };

async function startServerWithTempConfig(): Promise<Started> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-'));
  const home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.ROUTECODEX_SNAPSHOT = '0';

  const configPath = path.join(tmp, 'config.json');
  process.env.ROUTECODEX_CONFIG_PATH = configPath;

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        version: '1.0.0',
        httpserver: { host: '127.0.0.1', port: 0 },
        virtualrouter: { providers: {}, routing: { default: [] } }
      },
      null,
      2
    ),
    'utf8'
  );

  const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');
  const server = new RouteCodexHttpServer({
    server: { host: '127.0.0.1', port: 0 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  });

  await server.start();
  const raw = (server as unknown as { server?: http.Server }).server;
  if (!raw) {
    throw new Error('Test server missing underlying http.Server');
  }
  const addr = raw.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    throw new Error('Failed to resolve server port');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    stop: async () => {
      await server.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  };
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

describe('Daemon admin provider pool (v1 config) - e2e', () => {
  jest.setTimeout(30000);

  it('creates an authfile credential and persists provider config via /config/providers', async () => {
    const { baseUrl, stop } = await startServerWithTempConfig();
    try {
      const empty = await fetch(`${baseUrl}/config/providers`);
      expect(empty.status).toBe(200);
      const emptyBody = await readJson(empty);
      expect(emptyBody).toHaveProperty('ok', true);
      expect(Array.isArray(emptyBody.providers)).toBe(true);

      const deniedInline = await fetch(`${baseUrl}/config/providers/test`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: {
            enabled: true,
            type: 'responses',
            baseURL: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'raw-secret' }
          }
        })
      });
      expect(deniedInline.status).toBe(400);
      const deniedBody = await readJson(deniedInline);
      expect(String(deniedBody?.error?.message || '')).toContain('inline secret');

      const cred = await fetch(`${baseUrl}/daemon/credentials/apikey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'test', alias: 'default', apiKey: 'dummy-key' })
      });
      expect(cred.status).toBe(200);
      const credBody = await readJson(cred);
      expect(credBody).toHaveProperty('secretRef');
      expect(String(credBody.secretRef)).toMatch(/^authfile-/);

      const upsert = await fetch(`${baseUrl}/config/providers/test`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: {
            enabled: true,
            type: 'responses',
            baseURL: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: credBody.secretRef }
          }
        })
      });
      expect(upsert.status).toBe(200);
      const upsertBody = await readJson(upsert);
      expect(upsertBody).toHaveProperty('ok', true);

      const getProvider = await fetch(`${baseUrl}/config/providers/test`);
      expect(getProvider.status).toBe(200);
      const providerBody = await readJson(getProvider);
      expect(providerBody).toHaveProperty('ok', true);
      expect(providerBody).toHaveProperty('id', 'test');
      expect(providerBody).toHaveProperty('provider.auth.apiKey', credBody.secretRef);

      const creds = await fetch(`${baseUrl}/daemon/credentials`);
      expect(creds.status).toBe(200);
      const credsBody = await readJson(creds);
      const apikeyEntry = (credsBody as any[]).find((c) => c.kind === 'apikey' && c.provider === 'test');
      expect(apikeyEntry).toBeTruthy();
      expect(apikeyEntry).toHaveProperty('secretRef', credBody.secretRef);

      const removed = await fetch(`${baseUrl}/config/providers/test`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
      const removedBody = await readJson(removed);
      expect(removedBody).toHaveProperty('ok', true);
    } finally {
      await stop();
    }
  });

  it('serves /daemon/admin UI HTML', async () => {
    const { baseUrl, stop } = await startServerWithTempConfig();
    try {
      const res = await fetch(`${baseUrl}/daemon/admin`, { method: 'GET' });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<html');
      expect(text).toContain('RouteCodex Daemon Admin');
    } finally {
      await stop();
    }
  });
});
