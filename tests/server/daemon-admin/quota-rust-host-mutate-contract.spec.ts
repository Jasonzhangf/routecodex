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

describe('daemon-admin quota rust host mutate contract', () => {
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

  it('drives reset/recover/disable through rust virtual router host mutate contract in unified quota mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-rust-quota-mutate-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_LOGIN_FILE = createdLoginFile;

    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true,
        phase2UnifiedControl: true
      },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));

    const providerKey = 'quota.key1.gpt-test';
    const rustProviderKey = 'quota.1.gpt-test';
    let rustState = {
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
    };

    const rustMutations = {
      reset: jest.fn((key: string) => {
        expect(key).toBe(providerKey);
        rustState = {
          ...rustState,
          inPool: true,
          reason: 'active',
          cooldownUntil: null,
          blacklistUntil: null,
          resetAt: null,
          lastErrorSeries: null as any,
          lastErrorCode: null as any,
          lastErrorAtMs: null as any,
          consecutiveErrorCount: 0,
          selectionPenalty: 0,
          lastProviderGuardApplied: false
        };
        return { ok: true, providerKey: rustProviderKey, source: 'rust' };
      }),
      recover: jest.fn((key: string) => {
        expect(key).toBe(providerKey);
        rustState = {
          ...rustState,
          inPool: true,
          reason: 'active',
          cooldownUntil: null,
          blacklistUntil: null,
          resetAt: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0
        };
        return { ok: true, providerKey: rustProviderKey, source: 'rust' };
      }),
      disable: jest.fn((key: string, mode: string, durationMs: number) => {
        expect(key).toBe(providerKey);
        rustState = {
          ...rustState,
          inPool: false,
          reason: mode === 'blacklist' ? 'blacklist' : 'cooldown',
          cooldownUntil: mode === 'cooldown' ? Date.now() + durationMs : rustState.cooldownUntil,
          blacklistUntil: mode === 'blacklist' ? Date.now() + durationMs : null,
          consecutiveErrorCount: Math.max(rustState.consecutiveErrorCount, 1),
          selectionPenalty: Math.max(rustState.selectionPenalty, 1)
        };
        return { ok: true, providerKey: rustProviderKey, mode, durationMs, source: 'rust' };
      })
    };

    const staleCoreSnapshot = {
      [providerKey]: {
        providerKey,
        inPool: false,
        reason: 'quotaDepleted',
        authType: 'unknown',
        authIssue: null,
        priorityTier: 999,
        cooldownUntil: 999999999,
        blacklistUntil: null,
        consecutiveErrorCount: 9
      }
    };

    const daemon = {
      getModule: (id: string) => {
        if (id !== 'quota') return undefined;
        return {
          id: 'quota',
          getCoreQuotaManager: () => ({
            getSnapshot: () => ({ updatedAtMs: Date.now(), providers: staleCoreSnapshot }),
            getQuotaView: () => (key: string) => staleCoreSnapshot[key] ?? null,
            resetProvider: jest.fn(() => ({ ok: true, source: 'ts-core' })),
            recoverProvider: jest.fn(() => ({ ok: true, source: 'ts-core' })),
            disableProvider: jest.fn(() => ({ ok: true, source: 'ts-core' })),
            persistNow: jest.fn(async () => {})
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
          getStatus: () => ({ quotaHostSnapshot: [rustState] }),
          resetProviderQuota: rustMutations.reset,
          recoverProviderQuota: rustMutations.recover,
          disableProviderQuota: rustMutations.disable
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

      const resetResp = await fetch(`${base}/quota/providers/${providerKey}/reset`, {
        method: 'POST',
        headers: { cookie: String(cookie) }
      });
      expect(resetResp.status).toBe(200);
      expect(rustMutations.reset).toHaveBeenCalledTimes(1);

      const afterReset = await fetch(`${base}/quota/providers`, { headers: { cookie: String(cookie) } });
      const afterResetJson = await afterReset.json() as any;
      expect(afterResetJson.providers[0]).toMatchObject({
        providerKey: rustProviderKey,
        inPool: true,
        reason: 'active',
        consecutiveErrorCount: 0
      });

      const disableResp = await fetch(`${base}/quota/providers/${providerKey}/disable`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ mode: 'blacklist', durationMs: 60_000 })
      });
      expect(disableResp.status).toBe(200);
      expect(rustMutations.disable).toHaveBeenCalledWith(providerKey, 'blacklist', 60_000);

      const afterDisable = await fetch(`${base}/quota/providers`, { headers: { cookie: String(cookie) } });
      const afterDisableJson = await afterDisable.json() as any;
      expect(afterDisableJson.providers[0]).toMatchObject({
        providerKey: rustProviderKey,
        inPool: false,
        reason: 'blacklist'
      });

      const recoverResp = await fetch(`${base}/quota/providers/${providerKey}/recover`, {
        method: 'POST',
        headers: { cookie: String(cookie) }
      });
      expect(recoverResp.status).toBe(200);
      expect(rustMutations.recover).toHaveBeenCalledTimes(1);

      const afterRecover = await fetch(`${base}/quota/providers`, { headers: { cookie: String(cookie) } });
      const afterRecoverJson = await afterRecover.json() as any;
      expect(afterRecoverJson.providers[0]).toMatchObject({
        providerKey: rustProviderKey,
        inPool: true,
        reason: 'active'
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
