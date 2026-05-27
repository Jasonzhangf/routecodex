import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerControlRoutes } from '../../../src/server/runtime/http-server/daemon-admin/control-handler.js';

const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

describe('daemon-admin unified quota.setQuota rust-first contract', () => {
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

  it('routes quota.setQuota through rust host mutate instead of TS updateProviderPoolState second center', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-control-rust-quota-set-'));
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
      inPool: true,
      reason: 'active',
      authType: 'apikey',
      authIssue: null,
      priorityTier: 100,
      cooldownUntil: null,
      cooldownKeepsPool: undefined,
      blacklistUntil: null,
      resetAt: null,
      lastErrorSeries: null,
      lastErrorCode: null,
      lastErrorAtMs: null,
      consecutiveErrorCount: 0,
      selectionPenalty: 0,
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
          cooldownKeepsPool: undefined,
          blacklistUntil: null,
          resetAt: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0,
          lastProviderGuardApplied: false
        };
        return { ok: true, source: 'rust' };
      }),
      disable: jest.fn((key: string, mode: string, durationMs: number) => {
        expect(key).toBe(providerKey);
        expect(durationMs).toBeGreaterThan(0);
        if (mode === 'blacklist') {
          rustState = {
            ...rustState,
            inPool: false,
            reason: 'blacklist',
            cooldownUntil: null,
            cooldownKeepsPool: undefined,
            blacklistUntil: Date.now() + durationMs,
            lastErrorSeries: 'EFATAL',
            lastErrorCode: 'OPERATOR_BLACKLIST',
            lastErrorAtMs: Date.now(),
            consecutiveErrorCount: 1,
            selectionPenalty: 1
          };
          return { ok: true, source: 'rust' };
        }
        rustState = {
          ...rustState,
          inPool: false,
          reason: 'quotaDepleted',
          cooldownUntil: Date.now() + durationMs,
          cooldownKeepsPool: false,
          blacklistUntil: null,
          lastErrorSeries: 'E429',
          lastErrorCode: 'QUOTA_DEPLETED',
          lastErrorAtMs: Date.now(),
          consecutiveErrorCount: 1,
          selectionPenalty: 1
        };
        return { ok: true, source: 'rust' };
      }),
      recover: jest.fn((key: string) => {
        expect(key).toBe(providerKey);
        rustState = {
          ...rustState,
          inPool: true,
          reason: 'active',
          cooldownUntil: null,
          cooldownKeepsPool: undefined,
          blacklistUntil: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0
        };
        return { ok: true, source: 'rust' };
      })
    };

    const updateProviderPoolState = jest.fn();
    const daemon = {
      getModule: (id: string) => {
        if (id !== 'quota') return undefined;
        return {
          id: 'quota',
          getCoreQuotaManager: () => ({
            getSnapshot: () => ({ updatedAtMs: Date.now(), providers: { [providerKey]: { providerKey, inPool: true, reason: 'ok' } } }),
            getQuotaView: () => (key: string) => ({ providerKey: key, inPool: true, reason: 'ok' }),
            updateProviderPoolState,
            recoverProvider: jest.fn(),
            resetProvider: jest.fn(),
            disableProvider: jest.fn(),
            persistNow: jest.fn(async () => {})
          })
        };
      }
    };

    const app = express();
    app.use(express.json());
    registerDaemonAuthRoutes(app);
    registerControlRoutes(app, {
      app,
      getManagerDaemon: () => daemon,
      getServerId: () => 'test:0',
      getVirtualRouterArtifacts: () => null,
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          getStatus: () => ({ quotaHostSnapshot: [rustState] }),
          resetProviderQuota: rustMutations.reset,
          disableProviderQuota: rustMutations.disable,
          recoverProviderQuota: rustMutations.recover
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

      const depleted = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.setQuota', providerKey, quota: 0 })
      });
      expect(depleted.status).toBe(200);
      expect(rustMutations.disable).toHaveBeenCalledTimes(1);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const depletedJson = await depleted.json() as any;
      expect(depletedJson.snapshot).toMatchObject({
        providerKey: rustProviderKey,
        inPool: false,
        reason: 'quotaDepleted'
      });


      const disableResp = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.disable', providerKey, mode: 'blacklist', durationMs: 60_000 })
      });
      expect(disableResp.status).toBe(200);
      expect(rustMutations.disable).toHaveBeenCalledWith(providerKey, 'blacklist', 60_000);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const disableJson = await disableResp.json() as any;
      expect(disableJson.result).toMatchObject({ ok: true, source: 'rust' });

      const clearCooldownResp = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.clearCooldown', providerKey })
      });
      expect(clearCooldownResp.status).toBe(200);
      expect(rustMutations.recover).toHaveBeenCalledTimes(1);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const clearCooldownJson = await clearCooldownResp.json() as any;
      expect(clearCooldownJson.result).toMatchObject({ ok: true, source: 'rust' });
      expect(clearCooldownJson.snapshot).toMatchObject({
        providerKey: rustProviderKey,
        inPool: true,
        reason: 'active'
      });


      const recoverResp = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.recover', providerKey })
      });
      expect(recoverResp.status).toBe(200);
      expect(rustMutations.recover).toHaveBeenCalledTimes(2);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const recoverJson = await recoverResp.json() as any;
      expect(recoverJson.result).toMatchObject({ ok: true, source: 'rust' });

      const restoreNowResp = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.reset', providerKey })
      });
      expect(restoreNowResp.status).toBe(200);
      expect(rustMutations.reset).toHaveBeenCalledTimes(1);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const restoreNowJson = await restoreNowResp.json() as any;
      expect(restoreNowJson.result).toMatchObject({ ok: true, source: 'rust' });

      const recovered = await fetch(`${base}/daemon/control/mutate`, {
        method: 'POST',
        headers: {
          cookie: String(cookie),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action: 'quota.setQuota', providerKey, quota: 10 })
      });
      expect(recovered.status).toBe(200);
      expect(rustMutations.recover).toHaveBeenCalledTimes(3);
      expect(updateProviderPoolState).not.toHaveBeenCalled();
      const recoveredJson = await recovered.json() as any;
      expect(recoveredJson.snapshot).toMatchObject({
        providerKey: rustProviderKey,
        inPool: true,
        reason: 'active'
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
