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
  configPath: string;
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
  return { server, baseUrl, configPath, configDir, restoreEnv, apikey };
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

      // Control snapshot should expose antigravity alias lease state when the persisted file is present.
      const leasePath = path.join(os.homedir(), '.routecodex', 'state', 'antigravity-alias-leases.json');
      await fs.mkdir(path.dirname(leasePath), { recursive: true });
      await fs.writeFile(
        leasePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: Date.now(),
            leases: {
              'antigravity.aliasA::gemini': { sessionKey: 'session:abc::gemini', lastSeenAt: Date.now() }
            }
          },
          null,
          2
        ),
        'utf8'
      );
      const serverToolLogPath = path.join(os.homedir(), '.routecodex', 'logs', 'servertool-events.jsonl');
      await fs.mkdir(path.dirname(serverToolLogPath), { recursive: true });
      await fs.writeFile(
        serverToolLogPath,
        [
          JSON.stringify({
            ts: new Date(Date.now() - 1000).toISOString(),
            requestId: 'req_servertool_test_1',
            flowId: 'continue_execution_flow',
            tool: 'continue_execution',
            stage: 'match',
            result: 'matched',
            message: 'matched'
          }),
          JSON.stringify({
            ts: new Date().toISOString(),
            requestId: 'req_servertool_test_1',
            flowId: 'continue_execution_flow',
            tool: 'continue_execution',
            stage: 'final',
            result: 'completed',
            message: 'completed'
          })
        ].join('\n') + '\n',
        'utf8'
      );
      const controlSnap = await getJson(baseUrl, '/daemon/control/snapshot', cookie);
      expect(controlSnap.status).toBe(200);
      expect(controlSnap.body).toHaveProperty('routing');
      expect(controlSnap.body.routing).toHaveProperty('antigravityAliasLeases');
      expect(controlSnap.body.routing.antigravityAliasLeases).toHaveProperty('leases');
      expect(controlSnap.body).toHaveProperty('serverTool');
      expect(controlSnap.body.serverTool.state).toHaveProperty('enabled', true);
      expect(Number(controlSnap.body.serverTool.stats?.executions ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(controlSnap.body.serverTool.stats?.success ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(controlSnap.body.serverTool.stats?.byTool)).toBe(true);
      const continueExecutionStats = (controlSnap.body.serverTool.stats?.byTool ?? []).find(
        (entry: { tool?: string }) => entry?.tool === 'continue_execution'
      );
      expect(Number(continueExecutionStats?.executions ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(continueExecutionStats?.success ?? 0)).toBeGreaterThanOrEqual(1);

      const disableServerTool = await postJson(
        baseUrl,
        '/daemon/control/mutate',
        { action: 'servertool.set_enabled', enabled: false },
        cookie
      );
      expect(disableServerTool.status).toBe(200);
      expect(disableServerTool.body).toHaveProperty('ok', true);
      expect(disableServerTool.body.state).toHaveProperty('enabled', false);
      const controlSnapAfterDisable = await getJson(baseUrl, '/daemon/control/snapshot', cookie);
      expect(controlSnapAfterDisable.status).toBe(200);
      expect(controlSnapAfterDisable.body.serverTool.state).toHaveProperty('enabled', false);

      const enableServerTool = await postJson(
        baseUrl,
        '/daemon/control/mutate',
        { action: 'servertool.set_enabled', enabled: true },
        cookie
      );
      expect(enableServerTool.status).toBe(200);
      expect(enableServerTool.body).toHaveProperty('ok', true);
      expect(enableServerTool.body.state).toHaveProperty('enabled', true);

      const stats = await getJson(baseUrl, '/daemon/stats', cookie);
      expect(stats.status).toBe(200);
      expect(stats.body).toHaveProperty('ok', true);
      expect(stats.body).toHaveProperty('session');
      expect(stats.body).toHaveProperty('historical');
      expect(stats.body).toHaveProperty('totals');

      const creds = await getJson(baseUrl, '/daemon/credentials', cookie);
      expect(creds.status).toBe(200);
      expect(Array.isArray(creds.body)).toBe(true);

      const missingRefresh = await postJson(baseUrl, '/daemon/credentials/non-existent/refresh', undefined, cookie);
      expect(missingRefresh.status).toBe(404);
      expect(missingRefresh.body).toHaveProperty('error.code', 'not_found');

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

  it('does not expose legacy /daemon/clock-admin route', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);
      const out = await getJson(baseUrl, '/daemon/clock-admin', cookie);
      expect(out.status).toBe(404);
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

  it('logout clears server-side session entry', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);

      const statusBefore = await getJson(baseUrl, '/daemon/auth/status', cookie);
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body).toHaveProperty('authenticated', true);

      const logout = await postJson(baseUrl, '/daemon/auth/logout', undefined, cookie);
      expect(logout.status).toBe(200);
      expect(logout.body).toHaveProperty('ok', true);

      const statusAfter = await getJson(baseUrl, '/daemon/auth/status', cookie);
      expect(statusAfter.status).toBe(200);
      expect(statusAfter.body).toHaveProperty('authenticated', false);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('supports manual quota provider operations via HTTP', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    const cookie = await setupDaemonAdminAuth(baseUrl);
    const providerKey = encodeURIComponent('mock.dummy');
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
      const found = (list.body.providers as any[]).find((p) => p && p.providerKey === 'mock.dummy');
      expect(found).toBeDefined();
      expect(found.inPool).toBe(true);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('supports unified quota mutate actions (setQuota/clearCooldown/restoreNow)', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    const cookie = await setupDaemonAdminAuth(baseUrl);
    const providerKey = 'mock.dummy';
    try {
      const setDepleted = await postJson(
        baseUrl,
        '/daemon/control/mutate',
        { action: 'quota.setQuota', providerKey, quota: 0 },
        cookie
      );
      expect(setDepleted.status).toBe(200);
      expect(setDepleted.body).toHaveProperty('ok', true);
      expect(setDepleted.body.snapshot).toHaveProperty('providerKey', providerKey);
      expect(setDepleted.body.snapshot).toHaveProperty('inPool', false);

      const clearCooldown = await postJson(
        baseUrl,
        '/daemon/control/mutate',
        { action: 'quota.clearCooldown', providerKey },
        cookie
      );
      expect(clearCooldown.status).toBe(200);
      expect(clearCooldown.body).toHaveProperty('ok', true);
      expect(clearCooldown.body.snapshot).toHaveProperty('providerKey', providerKey);
      expect(clearCooldown.body.snapshot).toHaveProperty('inPool', true);

      const restoreNow = await postJson(
        baseUrl,
        '/daemon/control/mutate',
        { action: 'quota.restoreNow', providerKey },
        cookie
      );
      expect(restoreNow.status).toBe(200);
      expect(restoreNow.body).toHaveProperty('ok', true);
      expect(restoreNow.body.snapshot).toHaveProperty('providerKey', providerKey);
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('exposes routing policy + supports routing.policy.set', async () => {
    const { server, baseUrl, configDir, configPath, restoreEnv } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);
      const snap1 = await getJson(baseUrl, '/daemon/control/snapshot', cookie);
      expect(snap1.status).toBe(200);
      expect(snap1.body).toHaveProperty('routing');
      expect(snap1.body.routing).toHaveProperty('policy');
      expect(snap1.body.routing.policy).toHaveProperty('schemaVersion', 1);
      expect(snap1.body.routing.policy).toHaveProperty('virtualrouter');
      expect(snap1.body.routing.policy.virtualrouter).toHaveProperty('routing');
      expect(typeof snap1.body.routing.policyHash).toBe('string');

      const newPolicy = {
        virtualrouter: {
          routing: { default: ['mock.dummy'] },
          loadBalancing: { strategy: 'round-robin' }
        }
      };
      const mutate = await postJson(baseUrl, '/daemon/control/mutate', { action: 'routing.policy.set', policy: newPolicy }, cookie);
      expect(mutate.status).toBe(200);
      expect(mutate.body).toHaveProperty('ok', true);
      expect(mutate.body).toHaveProperty('policyHash');
      expect(typeof mutate.body.policyHash).toBe('string');

      const snap2 = await getJson(baseUrl, '/daemon/control/snapshot', cookie);
      expect(snap2.status).toBe(200);
      expect(snap2.body.routing.policyHash).toBe(mutate.body.policyHash);
      expect(snap2.body.routing.policy?.virtualrouter).toHaveProperty('loadBalancing');

      const cfgRaw = await fs.readFile(configPath, 'utf8');
      const cfg = cfgRaw.trim() ? JSON.parse(cfgRaw) : {};
      expect(cfg).toHaveProperty('virtualrouter');
      expect(cfg.virtualrouter).toHaveProperty('loadBalancing');
      expect(cfg.virtualrouter.loadBalancing).toHaveProperty('strategy', 'round-robin');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });
});
