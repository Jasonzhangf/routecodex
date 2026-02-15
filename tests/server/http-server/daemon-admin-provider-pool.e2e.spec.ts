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
  process.env.ROUTECODEX_AUTH_DIR = path.join(tmp, 'auth');
  // Ensure daemon admin auth is isolated from any pre-existing login file in the test runner env.
  process.env.ROUTECODEX_LOGIN_FILE = path.join(tmp, 'login');

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

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0]?.trim() || '';
  return cookie;
}

async function ensureDaemonSession(baseUrl: string): Promise<string> {
  const password = 'test-password-1234';
  const setup = await fetch(`${baseUrl}/daemon/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (setup.status === 200) {
    const cookie = extractCookie(setup);
    if (!cookie) {
      throw new Error('daemon auth setup succeeded but no cookie returned');
    }
    return cookie;
  }
  // Already configured: login instead.
  if (setup.status === 409) {
    const login = await fetch(`${baseUrl}/daemon/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (login.status !== 200) {
      throw new Error(`daemon auth login failed: ${login.status}`);
    }
    const cookie = extractCookie(login);
    if (!cookie) {
      throw new Error('daemon auth login succeeded but no cookie returned');
    }
    return cookie;
  }
  const body = await readJson(setup);
  throw new Error(`daemon auth setup failed: ${setup.status} ${JSON.stringify(body)}`);
}

describe('Daemon admin provider pool (v1 config) - e2e', () => {
  jest.setTimeout(30000);

  it('lists and edits routing sources across active/import/provider configs', async () => {
    const { baseUrl, stop } = await startServerWithTempConfig();
    try {
      const cookie = await ensureDaemonSession(baseUrl);

      const home = process.env.HOME || '';
      if (!home) {
        throw new Error('Missing HOME env in test');
      }

      const routecodexHome = path.join(home, '.routecodex');
      const importedDir = path.join(routecodexHome, 'config', 'multi');
      const providerDir = path.join(routecodexHome, 'provider', 'demo');
      await fs.mkdir(importedDir, { recursive: true });
      await fs.mkdir(providerDir, { recursive: true });

      const defaultConfigPath = path.join(routecodexHome, 'config.json');
      const importedConfigPath = path.join(importedDir, 'imported.json');
      const providerConfigPath = path.join(providerDir, 'config.v1.json');

      await fs.writeFile(
        defaultConfigPath,
        JSON.stringify({
          version: '1.0.0',
          virtualrouter: {
            providers: {},
            routing: { default: ['mock.dummy'] },
            loadBalancing: { strategy: 'priority' }
          }
        }, null, 2),
        'utf8'
      );
      await fs.writeFile(
        importedConfigPath,
        JSON.stringify({
          version: '1.0.0',
          virtualrouter: {
            providers: {},
            routing: { default: ['mock.dummy'], tools: [] },
            loadBalancing: { strategy: 'priority' }
          }
        }, null, 2),
        'utf8'
      );
      await fs.writeFile(
        providerConfigPath,
        JSON.stringify({
          version: '1.0.0',
          virtualrouter: {
            providers: {},
            routing: { default: ['demo.model'] },
            loadBalancing: { strategy: 'priority' }
          }
        }, null, 2),
        'utf8'
      );

      const sourcesRes = await fetch(`${baseUrl}/config/routing/sources`, { headers: { cookie } });
      expect(sourcesRes.status).toBe(200);
      const sourcesBody = await readJson(sourcesRes);
      expect(sourcesBody).toHaveProperty('ok', true);
      expect(Array.isArray(sourcesBody.sources)).toBe(true);
      const paths = (sourcesBody.sources as any[]).map((s) => String(s.path || ''));
      expect(paths).toContain(defaultConfigPath);
      expect(paths).toContain(importedConfigPath);
      expect(paths).toContain(providerConfigPath);

      const importedGet = await fetch(
        `${baseUrl}/config/routing?path=${encodeURIComponent(importedConfigPath)}`,
        { headers: { cookie } }
      );
      expect(importedGet.status).toBe(200);
      const importedBody = await readJson(importedGet);
      expect(importedBody).toHaveProperty('ok', true);
      expect(importedBody).toHaveProperty('location', 'virtualrouter.routing');
      expect(importedBody).toHaveProperty('routing.default');
      expect(importedBody).toHaveProperty('hasLoadBalancing', true);
      expect(importedBody).toHaveProperty('loadBalancing.strategy', 'priority');

      const nextRouting = { ...(importedBody.routing || {}), tools: ['mock.dummy'] };
      const nextLoadBalancing = { ...(importedBody.loadBalancing || {}), strategy: 'round-robin' };
      const importedPut = await fetch(
        `${baseUrl}/config/routing?path=${encodeURIComponent(importedConfigPath)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            routing: nextRouting,
            loadBalancing: nextLoadBalancing,
            location: importedBody.location
          })
        }
      );
      expect(importedPut.status).toBe(200);
      const putBody = await readJson(importedPut);
      expect(putBody).toHaveProperty('ok', true);
      expect(putBody).toHaveProperty('location', 'virtualrouter.routing');
      expect(putBody).toHaveProperty('hasLoadBalancing', true);
      expect(putBody).toHaveProperty('loadBalancing.strategy', 'round-robin');

      const preservePut = await fetch(
        `${baseUrl}/config/routing?path=${encodeURIComponent(importedConfigPath)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            routing: { ...(nextRouting || {}), default: ['mock.dummy'] },
            location: importedBody.location
          })
        }
      );
      expect(preservePut.status).toBe(200);
      const preserveBody = await readJson(preservePut);
      expect(preserveBody).toHaveProperty('ok', true);
      expect(preserveBody).toHaveProperty('hasLoadBalancing', true);
      expect(preserveBody).toHaveProperty('loadBalancing.strategy', 'round-robin');

      const afterText = await fs.readFile(importedConfigPath, 'utf8');
      const after = JSON.parse(afterText);
      expect(after).toHaveProperty('virtualrouter.routing.tools');
      expect(Array.isArray(after.virtualrouter.routing.tools)).toBe(true);
      expect(after.virtualrouter.routing.tools).toEqual(['mock.dummy']);
      expect(after).toHaveProperty('virtualrouter.loadBalancing.strategy', 'round-robin');

      const forbidden = await fetch(
        `${baseUrl}/config/routing?path=${encodeURIComponent('/etc/passwd')}`,
        { headers: { cookie } }
      );
      expect(forbidden.status).toBe(403);
    } finally {
      await stop();
    }
  });

  it('creates an authfile credential and persists provider config via /config/providers', async () => {
    const { baseUrl, stop } = await startServerWithTempConfig();
    try {
      const cookie = await ensureDaemonSession(baseUrl);

      const empty = await fetch(`${baseUrl}/config/providers`, { headers: { cookie } });
      expect(empty.status).toBe(200);
      const emptyBody = await readJson(empty);
      expect(emptyBody).toHaveProperty('ok', true);
      expect(Array.isArray(emptyBody.providers)).toBe(true);

      const deniedInline = await fetch(`${baseUrl}/config/providers/test`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
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
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ provider: 'test', alias: 'default', apiKey: 'dummy-key' })
      });
      expect(cred.status).toBe(200);
      const credBody = await readJson(cred);
      expect(credBody).toHaveProperty('secretRef');
      expect(String(credBody.secretRef)).toMatch(/^authfile-/);

      const upsert = await fetch(`${baseUrl}/config/providers/test`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
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

      const getProvider = await fetch(`${baseUrl}/config/providers/test`, { headers: { cookie } });
      expect(getProvider.status).toBe(200);
      const providerBody = await readJson(getProvider);
      expect(providerBody).toHaveProperty('ok', true);
      expect(providerBody).toHaveProperty('id', 'test');
      expect(providerBody).toHaveProperty('provider.auth.apiKey', credBody.secretRef);

      const creds = await fetch(`${baseUrl}/daemon/credentials`, { headers: { cookie } });
      expect(creds.status).toBe(200);
      const credsBody = await readJson(creds);
      const apikeyEntry = (credsBody as any[]).find((c) => c.kind === 'apikey' && c.provider === 'test');
      expect(apikeyEntry).toBeTruthy();
      expect(apikeyEntry).toHaveProperty('secretRef', credBody.secretRef);

      const removed = await fetch(`${baseUrl}/config/providers/test`, { method: 'DELETE', headers: { cookie } });
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
      const cookie = await ensureDaemonSession(baseUrl);
      const res = await fetch(`${baseUrl}/daemon/admin`, { method: 'GET', headers: { cookie } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<html');
      expect(text).toContain('RouteCodex Daemon Admin');
    } finally {
      await stop();
    }
  });
});
