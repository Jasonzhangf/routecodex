import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Started = { baseUrl: string; stop: () => Promise<void> };

const fetchAntigravityQuotaSnapshot = jest.fn(async () => ({
  fetchedAt: Date.now(),
  models: {
    'claude-sonnet-4-5': { remainingFraction: 0, resetTimeRaw: new Date(Date.now() + 3600_000).toISOString() }
  }
}));

jest.unstable_mockModule('../../../src/providers/core/runtime/antigravity-quota-client.js', () => ({
  loadAntigravityAccessToken: async (tokenFile: string) => {
    const raw = await fs.readFile(tokenFile, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return typeof parsed?.access_token === 'string' ? parsed.access_token : undefined;
  },
  fetchAntigravityQuotaSnapshot
}));

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

async function startServerWithTempConfig(): Promise<Started> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-refresh-'));
  const home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.ROUTECODEX_SNAPSHOT = '0';
  process.env.ROUTECODEX_DISABLE_TOKEN_DAEMON = '1';
  process.env.ROUTECODEX_AUTH_DIR = path.join(tmp, 'auth');
  process.env.ROUTECODEX_LOGIN_FILE = path.join(tmp, 'login');
  process.env.ROUTECODEX_STATS_LOG = path.join(tmp, 'provider-stats.jsonl');

  await fs.mkdir(process.env.ROUTECODEX_AUTH_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.ROUTECODEX_AUTH_DIR, 'antigravity-oauth-1-geetasamodgeetasamoda.json'),
    JSON.stringify({ access_token: 'dummy-token' }, null, 2),
    'utf8'
  );

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

describe('Quota refresh triggers - e2e', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.resetModules();
    fetchAntigravityQuotaSnapshot.mockClear();
  });

  it('supports startup refresh, /daemon/modules/quota/refresh, and reset-triggered refresh for antigravity keys', async () => {
    const { baseUrl, stop } = await startServerWithTempConfig();
    try {
      const cookie = await ensureDaemonSession(baseUrl);

      const adminUi = await fetch(`${baseUrl}/daemon/admin`, { headers: { cookie } });
      expect(adminUi.status).toBe(200);
      const html = await adminUi.text();
      expect(html).toContain('<html');
      expect(html.includes('/daemon/modules/quota/refresh') || html.includes('/daemon/admin/assets/')).toBe(true);

      // Startup refresh should have happened at least once.
      expect(fetchAntigravityQuotaSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);

      const summary = await fetch(`${baseUrl}/quota/summary`, { headers: { cookie } });
      expect(summary.status).toBe(200);
      const summaryBody = await readJson(summary);
      const keys = Array.isArray(summaryBody?.records) ? summaryBody.records.map((r: any) => r.key) : [];
      expect(keys).toContain('antigravity://geetasamodgeetasamoda/claude-sonnet-4-5');

      const refresh = await fetch(`${baseUrl}/daemon/modules/quota/refresh`, { method: 'POST', headers: { cookie } });
      expect(refresh.status).toBe(200);

      const reset = await fetch(
        `${baseUrl}/quota/providers/${encodeURIComponent('antigravity.geetasamodgeetasamoda.claude-sonnet-4-5')}/reset`,
        { method: 'POST', headers: { cookie } }
      );
      expect(reset.status).toBe(200);
      const resetBody = await readJson(reset);
      expect(resetBody).toHaveProperty('ok', true);
      expect(resetBody).toHaveProperty('meta.quotaRefresh');

      const providers = await fetch(`${baseUrl}/quota/providers`, { headers: { cookie } });
      expect(providers.status).toBe(200);
      const providersBody = await readJson(providers);
      const list = Array.isArray(providersBody?.providers) ? providersBody.providers : [];
      const entry = list.find((p: any) => p?.providerKey === 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5');
      expect(entry).toBeTruthy();
      expect(entry).toHaveProperty('inPool', false);
      expect(entry).toHaveProperty('reason', 'quotaDepleted');
    } finally {
      await stop();
    }
  });
});
