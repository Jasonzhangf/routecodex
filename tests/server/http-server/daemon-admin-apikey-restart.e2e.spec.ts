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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-apikey-'));
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

function createTestConfig(port: number, configPath: string, apikey: string, host = '0.0.0.0'): ServerConfigV2 {
  return {
    configPath,
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

async function startTestServer(): Promise<{
  server: RouteCodexHttpServer;
  baseUrl: string;
  configDir: string;
  restoreEnv: () => void;
  apikey: string;
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
    setEnv('ROUTECODEX_SNAPSHOT', '0')
  ];
  const restoreEnv = () => {
    for (const fn of restores.reverse()) fn();
  };
  const apikey = 'test-http-apikey';
  await writeDaemonLoginRecord('routecodex-test-password-123');
  const server = new RouteCodexHttpServer(createTestConfig(0, configPath, apikey, '0.0.0.0'));
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
    apikey
  };
}

async function stopTestServer(server: RouteCodexHttpServer, configDir: string, restoreEnv: () => void): Promise<void> {
  await server.stop();
  restoreEnv();
  await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
}

async function getJson(baseUrl: string, endpoint: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'GET',
    headers
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null
  };
}

async function postJson(baseUrl: string, endpoint: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null
  };
}

describe('daemon-admin restart apikey auth', () => {
  it('accepts the shared http apikey for daemon admin status and restart', async () => {
    const { server, baseUrl, configDir, restoreEnv, apikey } = await startTestServer();
    try {
      const denied = await postJson(baseUrl, '/daemon/restart');
      expect(denied.status).toBe(401);

      const status = await getJson(baseUrl, '/daemon/auth/status', { 'x-api-key': apikey });
      expect(status.status).toBe(200);
      expect(status.body).toHaveProperty('apiKeyConfigured', true);
      expect(status.body).toHaveProperty('authenticated', true);
      expect(status.body).toHaveProperty('authRequired', true);

      const restart = await postJson(baseUrl, '/daemon/restart', { 'x-api-key': apikey });
      expect(restart.status).toBe(200);
      expect(restart.body).toHaveProperty('ok', true);
      expect(restart.body).toHaveProperty('configPath');
    } finally {
      await stopTestServer(server, configDir, restoreEnv);
    }
  });
});
