import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerStatusRoutes } from '../../../src/server/runtime/http-server/daemon-admin/status-handler.js';

describe('daemon-admin module reset fallback', () => {
  jest.setTimeout(10_000);

  const originalLoginFile = process.env.ROUTECODEX_LOGIN_FILE;
  let createdLoginFile: string | null = null;
  let createdTmpDir: string | null = null;

  afterEach(async () => {
    if (originalLoginFile === undefined) delete process.env.ROUTECODEX_LOGIN_FILE;
    else process.env.ROUTECODEX_LOGIN_FILE = originalLoginFile;

    if (createdLoginFile) {
      await fs.rm(createdLoginFile, { force: true }).catch(() => {});
      await fs.rm(path.dirname(createdLoginFile), { force: true, recursive: true }).catch(() => {});
    }
    if (createdTmpDir) {
      await fs.rm(createdTmpDir, { force: true, recursive: true }).catch(() => {});
    }
    createdLoginFile = null;
    createdTmpDir = null;
  });

  it('resets quota provider states when provider-quota module is absent', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_LOGIN_FILE = createdLoginFile;

    const calls: { reset: string[]; persist: number; refresh: number } = { reset: [], persist: 0, refresh: 0 };
    const quotaModule = {
      getAdminSnapshot: () => ({ 'antigravity.a.claude': {}, 'tab.key1.gpt-5.2-codex': {} }),
      resetProvider: (providerKey: string) => void calls.reset.push(providerKey),
      persistNow: async () => void (calls.persist += 1),
      refreshNow: async () => {
        calls.refresh += 1;
        return { ok: true, refreshedAt: Date.now() };
      }
    };
    const daemon = {
      getModule: (id: string) => {
        if (id === 'quota') return quotaModule as any;
        return undefined;
      }
    };

    const app = express();
    app.use(express.json());
    registerDaemonAuthRoutes(app);
    registerStatusRoutes(app, {
      app,
      getManagerDaemon: () => daemon,
      getServerId: () => 'test:0'
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const setup = await fetch(`${base}/daemon/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'password123' })
      });
      expect(setup.ok).toBe(true);
      const cookie = setup.headers.get('set-cookie');
      expect(typeof cookie).toBe('string');
      expect(cookie).toContain('routecodex_daemon_session=');

      const resp = await fetch(`${base}/daemon/modules/provider-quota/reset`, {
        method: 'POST',
        headers: { cookie: String(cookie) }
      });
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as any;
      expect(json?.ok).toBe(true);
      expect(json?.id).toBe('provider-quota');
      expect(json?.action).toBe('reset');
      expect(json?.fallback?.kind).toBe('quota.reset-all');
      expect(json?.fallback?.providerCount).toBe(2);

      expect(calls.reset.sort()).toEqual(['antigravity.a.claude', 'tab.key1.gpt-5.2-codex'].sort());
      expect(calls.persist).toBe(1);
      expect(calls.refresh).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
