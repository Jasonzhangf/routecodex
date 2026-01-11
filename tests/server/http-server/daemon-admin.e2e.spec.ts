import { jest } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

// 基于最小配置启动一个内存内 HTTP server，并调用 daemon-admin 相关只读 API。

function createTestConfig(port: number): ServerConfigV2 {
  return {
    server: {
      host: '127.0.0.1',
      port
    },
    pipeline: {},
    logging: {
      level: 'error',
      enableConsole: false
    },
    providers: {}
  };
}

async function startTestServer(): Promise<{ server: RouteCodexHttpServer; baseUrl: string }> {
  // 使用随机端口 0 启动 server，再从实际监听地址读取端口。
  const tmpConfig = createTestConfig(0);
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
  return { server, baseUrl };
}

async function stopTestServer(server: RouteCodexHttpServer): Promise<void> {
  await server.stop();
}

async function getJson(baseUrl: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET' });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('Daemon admin HTTP endpoints (smoke)', () => {
  jest.setTimeout(30000);

  it('exposes /daemon/status and basic admin endpoints without crashing', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const status = await getJson(baseUrl, '/daemon/status');
      expect(status.status).toBe(200);
      expect(status.body).toHaveProperty('ok', true);

      const creds = await getJson(baseUrl, '/daemon/credentials');
      expect(creds.status).toBe(200);
      expect(Array.isArray(creds.body)).toBe(true);

      const quota = await getJson(baseUrl, '/quota/summary');
      expect(quota.status).toBe(200);
      expect(quota.body).toHaveProperty('records');

      const providers = await getJson(baseUrl, '/providers/runtimes');
      expect(providers.status).toBe(200);
      expect(Array.isArray(providers.body)).toBe(true);
    } finally {
      await stopTestServer(server);
    }
  });
});

