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

async function createTempUserConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-port-mode-'));
  const filePath = path.join(dir, 'config.json');
  const config = {
    virtualrouterMode: 'v1',
    virtualrouter: {
      providers: {
        mock: {
          type: 'mock',
          endpoint: 'mock://',
          auth: { type: 'apiKey', value: 'dummy_dummy_dummy' },
          models: { dummy: {} },
        },
      },
      routing: { default: ['mock.dummy'] },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return filePath;
}

function createTestConfig(port: number, configPath: string, apikey?: string, host = '127.0.0.1'): ServerConfigV2 {
  return {
    configPath,
    server: {
      host,
      port,
      ...(apikey ? { apikey } : {}),
    },
    pipeline: {},
    logging: {
      level: 'error',
      enableConsole: false,
    },
    providers: {},
  } as ServerConfigV2;
}

async function startTestServer(): Promise<{
  server: RouteCodexHttpServer;
  baseUrl: string;
  configDir: string;
  restoreEnv: () => void;
}> {
  const configPath = await createTempUserConfig();
  const configDir = path.dirname(configPath);
  const home = path.join(configDir, 'home');
  await fs.mkdir(home, { recursive: true });
  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_AUTH_DIR', path.join(configDir, 'auth')),
    setEnv('ROUTECODEX_STATS_LOG', path.join(configDir, 'stats', 'stats.json')),
    setEnv('ROUTECODEX_LOGIN_FILE', path.join(configDir, 'login')),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
  ];
  const restoreEnv = () => {
    for (const fn of restores.reverse()) fn();
  };

  await writeDaemonLoginRecord('routecodex-test-password-123');
  const server = new RouteCodexHttpServer(createTestConfig(0, configPath, 'test-http-apikey', '0.0.0.0'));
  await server.start();
  const raw = (server as unknown as { server?: http.Server }).server;
  if (!raw) {
    throw new Error('Test server missing underlying http.Server');
  }
  const addr = raw.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    throw new Error('Failed to resolve server port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    configDir,
    restoreEnv,
  };
}

async function stopTestServer(server: RouteCodexHttpServer, configDir: string, restoreEnv: () => void): Promise<void> {
  await server.stop();
  restoreEnv();
  await fs.rm(configDir, { recursive: true, force: true });
}

async function postJson(baseUrl: string, endpoint: string, body: unknown, cookie?: string): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    setCookie: res.headers.get('set-cookie'),
  };
}

async function getJson(baseUrl: string, endpoint: string, cookie?: string): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'GET',
    headers: cookie ? { cookie } : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function deleteJson(baseUrl: string, endpoint: string, cookie?: string): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'DELETE',
    headers: cookie ? { cookie } : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function setupDaemonAdminAuth(baseUrl: string): Promise<string> {
  const password = 'routecodex-test-password-123';
  const setup = await postJson(baseUrl, '/daemon/auth/setup', { password });
  if (setup.status === 200 && typeof setup.setCookie === 'string' && setup.setCookie) {
    return setup.setCookie;
  }
  if (setup.status === 403 || setup.status === 409) {
    const login = await postJson(baseUrl, '/daemon/auth/login', { password });
    if (login.status === 200 && typeof login.setCookie === 'string' && login.setCookie) {
      return login.setCookie;
    }
  }
  throw new Error(`Unable to authenticate daemon admin: ${JSON.stringify(setup.body)}`);
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      const port = address?.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Missing allocated port'));
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function probePort(port: number): Promise<{ ok: true; statusCode?: number } | { ok: false; code?: string }> {
  return await new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
      },
      (res) => {
        res.resume();
        resolve({ ok: true, statusCode: res.statusCode });
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: error.code });
    });
  });
}

describe('port mode routing admin integration', () => {
  jest.setTimeout(30000);

  it('registers /admin/ports and hot-adds/removes a router listener', async () => {
    const { server, baseUrl, configDir, restoreEnv } = await startTestServer();
    try {
      const cookie = await setupDaemonAdminAuth(baseUrl);

      const providers = await getJson(baseUrl, '/admin/providers', cookie);
      expect(providers.status).toBe(200);
      expect(Array.isArray(providers.body.providers)).toBe(true);

      const initialPorts = await getJson(baseUrl, '/admin/ports', cookie);
      expect(initialPorts.status).toBe(200);
      expect(Array.isArray(initialPorts.body.ports)).toBe(true);
      expect(initialPorts.body.ports.length).toBeGreaterThanOrEqual(1);

      const extraPort = await allocatePort();
      const create = await fetch(`${baseUrl}/admin/ports/${extraPort}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        body: JSON.stringify({
          mode: 'router',
          host: '127.0.0.1',
        }),
      });
      const createBody = await create.json();
      expect(create.status).toBe(200);
      expect(createBody).toEqual(
        expect.objectContaining({
          port: extraPort,
          mode: 'router',
        }),
      );

      const health = await fetch(`http://127.0.0.1:${extraPort}/health`);
      expect(health.status).toBe(200);
      const healthJson = await health.json();
      expect(healthJson).toHaveProperty('server', 'routecodex');

      const listedPorts = await getJson(baseUrl, '/admin/ports', cookie);
      expect(listedPorts.status).toBe(200);
      expect(listedPorts.body.ports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            port: extraPort,
            status: 'running',
          }),
        ]),
      );

      const remove = await deleteJson(baseUrl, `/admin/ports/${extraPort}`, cookie);
      expect(remove.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterRemove = await probePort(extraPort);
      expect(afterRemove).toEqual(
        expect.objectContaining({
          ok: false,
        }),
      );
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });

  it('dispatches provider-mode ports through the direct pipeline owner instead of requestExecutor', async () => {
    const server = new RouteCodexHttpServer(createTestConfig(0, path.join(os.tmpdir(), 'noop-config.json')));
    const input = {
      requestId: 'req_port_mode_dispatch',
      entryEndpoint: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      query: {},
      body: { messages: [{ role: 'user', content: 'hello' }] },
      metadata: { stream: false, inboundStream: false },
    };

    const routerExecute = jest.fn(async () => ({ status: 200, body: { mode: 'router' } }));
    const providerExecute = jest.fn(async () => ({ status: 200, body: { mode: 'provider' } }));
    (server as any).requestExecutor = { execute: routerExecute };
    (server as any).executeProviderDirectPipelineForPort = providerExecute;
    (server as any).getPortConfigForLocalPort = jest
      .fn()
      .mockReturnValueOnce({ port: 4100, host: '127.0.0.1', mode: 'router' })
      .mockReturnValueOnce({
        port: 4200,
        host: '127.0.0.1',
        mode: 'provider',
        providerBinding: 'mock.dummy',
        protocolBehavior: 'auto',
      });

    const routerResult = await (server as any).executePortAwarePipeline(4100, input);
    const providerResult = await (server as any).executePortAwarePipeline(4200, input);

    expect(routerExecute).toHaveBeenCalledTimes(1);
    expect(providerExecute).toHaveBeenCalledTimes(1);
    expect(routerResult.body).toEqual({ mode: 'router' });
    expect(providerResult.body).toEqual({ mode: 'provider' });
  });

  it('builds available provider list from user config when runtime views are not populated yet', () => {
    const server = new RouteCodexHttpServer(createTestConfig(0, path.join(os.tmpdir(), 'noop-config.json')));
    (server as any).userConfig = {
      virtualrouter: {
        providers: {
          mock: {
            type: 'mock',
            models: {
              dummy: {},
            },
          },
        },
      },
    };

    expect(server.getAvailableProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'mock.dummy',
        }),
      ]),
    );
  });

  it('prefers the runtime bind port over userConfig httpserver.port when ports[] is not configured', () => {
    const server = new RouteCodexHttpServer(createTestConfig(10000, path.join(os.tmpdir(), 'noop-config.json')));
    (server as any).userConfig = {
      httpserver: {
        host: '0.0.0.0',
        port: 5562,
      },
    };

    expect(server.getPortConfigs()).toEqual([
      expect.objectContaining({
        port: 10000,
        host: '127.0.0.1',
        mode: 'router',
      }),
    ]);
  });
});
