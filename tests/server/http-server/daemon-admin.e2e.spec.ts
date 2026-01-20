import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

// 基于最小配置启动一个内存内 HTTP server，并调用 daemon-admin 相关只读 API。

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

async function createTempUserConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-'));
  const filePath = path.join(dir, 'config.json');
  const config = {
    virtualrouterMode: 'v1',
    virtualrouter: {
      providers: {
        mock: {
          type: 'mock',
          endpoint: 'mock://',
          auth: { type: 'apiKey', value: 'dummy_dummy_dummy' },
          models: { dummy: {} }
        }
      },
      routing: { default: ['mock.dummy'] }
    }
  };
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return filePath;
}

function createTestConfig(port: number, configPath: string, apikey?: string): ServerConfigV2 {
  return {
    configPath,
    server: {
      host: '127.0.0.1',
      port,
      ...(apikey ? { apikey } : {})
    },
    pipeline: {},
    logging: {
      level: 'error',
      enableConsole: false
    },
    providers: {}
  };
}

async function startTestServer(): Promise<{
  server: RouteCodexHttpServer;
  baseUrl: string;
  configDir: string;
  restoreEnv: () => void;
  apikey: string;
}> {
  // 使用随机端口 0 启动 server，再从实际监听地址读取端口。
  const configPath = await createTempUserConfig();
  const configDir = path.dirname(configPath);
  const home = path.join(configDir, 'home');
  await fs.mkdir(home, { recursive: true });
  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_AUTH_DIR', path.join(configDir, 'auth')),
    setEnv('ROUTECODEX_STATS_LOG', path.join(configDir, 'stats', 'stats.json')),
    setEnv('ROUTECODEX_LOGIN_FILE', path.join(configDir, 'login')),
    setEnv('ROUTECODEX_SNAPSHOT', '0')
  ];
  const restoreEnv = () => {
    for (const fn of restores.reverse()) fn();
  };
  const apikey = 'test-http-apikey';
  const tmpConfig = createTestConfig(0, configPath, apikey);
  const server = new RouteCodexHttpServer(tmpConfig);
  // 使用私有方法启动监听，以便读取实际端口；这里复用 start() 逻辑。
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
  return { server, baseUrl, configDir, restoreEnv, apikey };
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

async function getJson(baseUrl: string, endpoint: string, cookie?: string): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'GET',
    headers: cookie ? { cookie } : undefined
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function postJson(baseUrl: string, endpoint: string, body?: unknown, cookie?: string): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: parsed, setCookie };
}

async function setupDaemonAdminAuth(baseUrl: string): Promise<string> {
  const password = 'routecodex-test-password-123';
  const setup = await postJson(baseUrl, '/daemon/auth/setup', { password });
  if (setup.status === 200 && typeof setup.setCookie === 'string' && setup.setCookie) {
    return setup.setCookie;
  }
  if (setup.status === 409) {
    const login = await postJson(baseUrl, '/daemon/auth/login', { password });
    if (login.status === 200 && typeof login.setCookie === 'string' && login.setCookie) {
      return login.setCookie;
    }
    throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  throw new Error(`Setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
}

describe('Daemon admin HTTP endpoints (smoke)', () => {
  jest.setTimeout(30000);
  let tempQuotaDir: string | null = null;
  let restoreQuotaDir: (() => void) | null = null;

  beforeEach(async () => {
    tempQuotaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-quota-'));
    restoreQuotaDir = setEnv('ROUTECODEX_QUOTA_DIR', tempQuotaDir);
  });

  afterEach(async () => {
    restoreQuotaDir?.();
    restoreQuotaDir = null;
    if (tempQuotaDir) {
      try {
        await fs.rm(tempQuotaDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempQuotaDir = null;
  });

  it('exposes /daemon/status and basic admin endpoints without crashing', async () => {
    const { server, baseUrl, configDir, restoreEnv, apikey } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);

      const status = await getJson(baseUrl, '/daemon/status', cookie);
      expect(status.status).toBe(200);
      expect(status.body).toHaveProperty('ok', true);

      const stats = await getJson(baseUrl, '/daemon/stats', cookie);
      expect(stats.status).toBe(200);
      expect(stats.body).toHaveProperty('ok', true);
      expect(stats.body).toHaveProperty('session');
      expect(stats.body).toHaveProperty('historical');
      expect(stats.body).toHaveProperty('totals');

      const creds = await getJson(baseUrl, '/daemon/credentials', cookie);
      expect(creds.status).toBe(200);
      expect(Array.isArray(creds.body)).toBe(true);

      const quota = await getJson(baseUrl, '/quota/summary', cookie);
      expect(quota.status).toBe(200);
      expect(quota.body).toHaveProperty('records');

      const quotaRefresh = await postJson(baseUrl, '/quota/refresh', undefined, cookie);
      expect(quotaRefresh.status).toBe(200);
      expect(quotaRefresh.body).toHaveProperty('ok', true);

      const providers = await getJson(baseUrl, '/providers/runtimes', cookie);
      expect(providers.status).toBe(200);
      expect(Array.isArray(providers.body)).toBe(true);

      // Ensure httpserver.apikey is still enforced for non-admin endpoints.
      const deniedConfig = await getJson(baseUrl, '/config', cookie);
      expect(deniedConfig.status).toBe(401);
      const allowedConfig = await fetch(`${baseUrl}/config`, { headers: { 'x-api-key': apikey } });
      expect(allowedConfig.status).toBe(200);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('supports /daemon/restart for reloading config from disk', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);
      const out = await postJson(baseUrl, '/daemon/restart', undefined, cookie);
      if (out.status !== 200) {
        throw new Error(`Expected 200 but got ${out.status}: ${JSON.stringify(out.body)}`);
      }
      expect(out.body).toHaveProperty('ok', true);
      expect(out.body).toHaveProperty('reloadedAt');
      expect(out.body).toHaveProperty('configPath');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('supports manual quota provider operations via HTTP', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    const cookie = await setupDaemonAdminAuth(baseUrl);
    const providerKey = encodeURIComponent('tab.default.gpt-5.1');
    try {
      const reset = await postJson(baseUrl, `/quota/providers/${providerKey}/reset`, undefined, cookie);
      expect(reset.status).toBe(200);
      expect(reset.body).toHaveProperty('ok', true);

      const disable = await postJson(baseUrl, `/quota/providers/${providerKey}/disable`, {
        mode: 'cooldown',
        durationMinutes: 1
      }, cookie);
      expect(disable.status).toBe(200);
      expect(disable.body).toHaveProperty('ok', true);

      const recover = await postJson(baseUrl, `/quota/providers/${providerKey}/recover`, undefined, cookie);
      expect(recover.status).toBe(200);
      expect(recover.body).toHaveProperty('ok', true);

      const list = await getJson(baseUrl, '/quota/providers', cookie);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body?.providers)).toBe(true);
      const found = (list.body.providers as any[]).find((p) => p && p.providerKey === 'tab.default.gpt-5.1');
      expect(found).toBeDefined();
      expect(found.inPool).toBe(true);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });
});
