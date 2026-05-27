import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerQuotaRoutes } from '../../../src/server/runtime/http-server/daemon-admin/quota-handler.js';

const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

describe('daemon-admin quota rust host snapshot read bridge', () => {
  jest.setTimeout(10_000);

  const originalLoginFile = process.env.ROUTECODEX_LOGIN_FILE;
  let createdLoginFile: string | null = null;
  let createdTmpDir: string | null = null;

  afterEach(async () => {
    jest.resetModules();
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

  it('prefers rust quotaHostSnapshot over stale core getSnapshot() when serving /quota/providers in unified quota mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-rust-quota-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_LOGIN_FILE = createdLoginFile;

    const providerKey = 'quota.key1.gpt-test';
    const rustProviderKey = 'quota.1.gpt-test';

    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true,
        phase2UnifiedControl: true
      },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));

    const staleCoreSnapshot = {
      [providerKey]: {
        providerKey,
        inPool: true,
        reason: 'active',
        authType: 'unknown',
        authIssue: null,
        priorityTier: 999,
        cooldownUntil: null,
        blacklistUntil: null,
        consecutiveErrorCount: 0
      }
    };

    const daemon = {
      getModule: (id: string) => {
        if (id !== 'quota') {
          return undefined;
        }
        return {
          id: 'quota',
          getCoreQuotaManager: () => ({
            getSnapshot: () => ({
              updatedAtMs: Date.now(),
              providers: staleCoreSnapshot
            }),
            getQuotaView: () => (key: string) => staleCoreSnapshot[key] ?? null
          })
        };
      }
    };

    const app = express();
    app.use(express.json());
    registerDaemonAuthRoutes(app);
    registerQuotaRoutes(app, {
      app,
      getManagerDaemon: () => daemon,
      getServerId: () => 'test:0',
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          getStatus: () => ({
            quotaHostSnapshot: [
              {
                providerKey: rustProviderKey,
                inPool: false,
                reason: 'quotaDepleted',
                authType: 'apikey',
                authIssue: null,
                priorityTier: 100,
                cooldownUntil: 1234567890,
                cooldownKeepsPool: false,
                blacklistUntil: null,
                resetAt: 2234567890,
                lastErrorSeries: 'E429',
                lastErrorCode: 'QUOTA_DEPLETED',
                lastErrorAtMs: 1234567000,
                consecutiveErrorCount: 3,
                selectionPenalty: 3,
                lastProviderGuardApplied: false
              }
            ]
          })
        })
      })
    } as any);

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

      const resp = await fetch(`${base}/quota/providers`, {
        headers: { cookie: String(cookie) }
      });
      expect(resp.status).toBe(200);
      const json = await resp.json() as any;
      expect(Array.isArray(json.providers)).toBe(true);
      expect(json.providers).toHaveLength(1);
      expect(json.providers[0]).toMatchObject({
        providerKey: rustProviderKey,
        inPool: false,
        reason: 'quotaDepleted',
        authType: 'apikey',
        priorityTier: 100,
        cooldownUntil: 1234567890,
        consecutiveErrorCount: 3,
        schema: 'v2',
        updatedVia: 'unified_control'
      });
      expect(json.providers[0]).not.toMatchObject({
        providerKey,
        inPool: true,
        reason: 'active',
        authType: 'unknown',
        priorityTier: 999
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
