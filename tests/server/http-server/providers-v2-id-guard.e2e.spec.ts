import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';

interface StartedServer {
  baseUrl: string;
  providerRoot: string;
  stop: () => Promise<void>;
}

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

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function startServerForProviderGuard(): Promise<StartedServer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-provider-id-guard-'));
  const home = path.join(tmp, 'home');
  const providerRoot = path.join(tmp, 'providers');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(providerRoot, { recursive: true });

  const configPath = path.join(tmp, 'config.json');
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

  const restores = [
    setEnv('HOME', home),
    setEnv('ROUTECODEX_PROVIDER_DIR', providerRoot),
    setEnv('ROUTECODEX_CONFIG_PATH', configPath),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_AUTH_DIR', path.join(tmp, 'auth')),
    setEnv('ROUTECODEX_LOGIN_FILE', path.join(tmp, 'login'))
  ];

  const server = new RouteCodexHttpServer({
    server: { host: '127.0.0.1', port: 0 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  });

  await server.start();
  const rawServer = (server as unknown as { server?: http.Server }).server;
  if (!rawServer) {
    throw new Error('missing underlying server');
  }
  const addr = rawServer.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') {
    throw new Error('missing server address');
  }

  const stop = async (): Promise<void> => {
    await server.stop();
    for (const restore of restores.reverse()) {
      restore();
    }
    await fs.rm(tmp, { recursive: true, force: true });
  };

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    providerRoot,
    stop
  };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0]?.trim() || '';
}

async function ensureDaemonSession(baseUrl: string): Promise<string> {
  const password = 'routecodex-test-password-123';
  const setup = await fetch(`${baseUrl}/daemon/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (setup.status === 200) {
    return extractCookie(setup);
  }
  if (setup.status === 409) {
    const login = await fetch(`${baseUrl}/daemon/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (login.status !== 200) {
      throw new Error(`daemon login failed: ${login.status}`);
    }
    return extractCookie(login);
  }
  throw new Error(`daemon setup failed: ${setup.status}`);
}

describe('providers v2 id guard - e2e', () => {
  jest.setTimeout(30000);

  it('rejects daemon-admin provider endpoints without session cookie', async () => {
    const started = await startServerForProviderGuard();
    try {
      const unauthorized = await fetch(`${started.baseUrl}/config/providers/v2`);
      expect(unauthorized.status).toBe(401);
      expect(await readBody(unauthorized)).toMatchObject({
        error: { code: 'unauthorized' }
      });
    } finally {
      await started.stop();
    }
  });

  it('rejects unsafe provider ids and blocks escaped writes', async () => {
    const started = await startServerForProviderGuard();
    try {
      const cookie = await ensureDaemonSession(started.baseUrl);
      const invalidCreate = await fetch(`${started.baseUrl}/config/providers/v2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          providerId: '../evil',
          provider: {
            providerType: 'openai',
            compatibilityProfile: 'openai-responses',
            auth: { type: 'apiKey', tokenFile: 'authfile-test-token' },
            models: { 'qwen/qwen3.6-plus:free': {} }
          }
        })
      });

      expect(invalidCreate.status).toBe(400);
      expect(await readBody(invalidCreate)).toMatchObject({
        error: { code: 'bad_request' }
      });

      const escapedPath = path.join(path.dirname(started.providerRoot), 'evil', 'config.v2.json');
      expect(await fileExists(escapedPath)).toBe(false);

      const invalidDelete = await fetch(`${started.baseUrl}/config/providers/v2/.evil`, {
        method: 'DELETE',
        headers: { cookie }
      });
      expect(invalidDelete.status).toBe(400);
      expect(await readBody(invalidDelete)).toMatchObject({
        error: { code: 'bad_request' }
      });

      const invalidGet = await fetch(`${started.baseUrl}/config/providers/v2/.evil`, {
        headers: { cookie }
      });
      expect(invalidGet.status).toBe(400);
      expect(await readBody(invalidGet)).toMatchObject({
        error: { code: 'bad_request' }
      });

      const outsideDir = path.join(path.dirname(started.providerRoot), 'outside-target');
      const linkedProviderDir = path.join(started.providerRoot, 'linkedprovider');
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, linkedProviderDir);

      const symlinkCreate = await fetch(`${started.baseUrl}/config/providers/v2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          providerId: 'linkedprovider',
          provider: {
            providerType: 'openai',
            compatibilityProfile: 'openai-responses',
            auth: { type: 'apiKey', tokenFile: 'authfile-test-token' },
            models: { 'qwen/qwen3.6-plus:free': {} }
          }
        })
      });
      expect(symlinkCreate.status).toBe(400);
      expect(await readBody(symlinkCreate)).toMatchObject({
        error: { code: 'bad_request' }
      });
      expect(await fileExists(path.join(outsideDir, 'config.v2.json'))).toBe(false);
    } finally {
      await started.stop();
    }
  });
});
