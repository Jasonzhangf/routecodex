import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerQuotaRoutes } from '../../../src/server/runtime/http-server/daemon-admin/quota-handler.js';

const BRIDGE_MODULE_PATH = '../../../src/modules/llmswitch/bridge.js';
const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

async function createAuthenticatedServer(
  daemon: { getModule: (id: string) => any },
  loginFile: string,
  hubPipeline?: unknown
): Promise<{
  base: string;
  cookie: string;
  close: () => Promise<void>;
}> {
  process.env.ROUTECODEX_LOGIN_FILE = loginFile;

  const app = express();
  app.use(express.json());
  registerDaemonAuthRoutes(app);
  registerQuotaRoutes(app, {
    app,
    getManagerDaemon: () => daemon,
    getServerId: () => 'test:0',
    getHubPipeline: () => hubPipeline ?? null
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const authResp = await fetch(`${base}/daemon/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password123' })
  });
  let cookie = String(authResp.headers.get('set-cookie') || '');
  if (!authResp.ok) {
    if (authResp.status !== 409) {
      throw new Error(`auth setup failed: ${authResp.status}`);
    }
    const loginResp = await fetch(`${base}/daemon/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' })
    });
    if (!loginResp.ok) {
      throw new Error(`auth login failed: ${loginResp.status}`);
    }
    cookie = String(loginResp.headers.get('set-cookie') || '');
  }
  return {
    base,
    cookie,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function createMockHubPipeline(rustStateRef: { current: Record<string, any> }) {
  return {
    getVirtualRouter: () => ({
      getStatus: () => ({
        quotaHostSnapshot: Object.values(rustStateRef.current)
      }),
      resetProviderQuota: (providerKey: string) => {
        const state = rustStateRef.current[providerKey];
        rustStateRef.current[providerKey] = {
          ...(state ?? { providerKey, authType: 'unknown', priorityTier: 100 }),
          providerKey,
          inPool: true,
          reason: 'active',
          authIssue: null,
          cooldownUntil: null,
          blacklistUntil: null,
          resetAt: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0,
          lastProviderGuardApplied: false
        };
      },
      recoverProviderQuota: (providerKey: string) => {
        const state = rustStateRef.current[providerKey];
        rustStateRef.current[providerKey] = {
          ...(state ?? { providerKey, authType: 'unknown', priorityTier: 100 }),
          providerKey,
          inPool: true,
          reason: 'active',
          authIssue: null,
          cooldownUntil: null,
          blacklistUntil: null,
          resetAt: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0,
          lastProviderGuardApplied: false
        };
      },
      disableProviderQuota: (providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number) => {
        const nowMs = Date.now();
        const state = rustStateRef.current[providerKey];
        const until = nowMs + durationMs;
        rustStateRef.current[providerKey] = {
          ...(state ?? { providerKey, authType: 'unknown', priorityTier: 100 }),
          providerKey,
          inPool: false,
          reason: mode === 'blacklist' ? 'blacklist' : 'cooldown',
          authIssue: null,
          cooldownUntil: mode === 'cooldown' ? until : null,
          blacklistUntil: mode === 'blacklist' ? until : null,
          resetAt: null,
          consecutiveErrorCount: Math.max(Number(state?.consecutiveErrorCount ?? 0), 1),
          selectionPenalty: Math.max(Number(state?.selectionPenalty ?? 0), 1),
          lastProviderGuardApplied: false
        };
      },
      applyKeepPoolCooldownQuota: (providerKey: string, cooldownUntilMs: number, lastErrorCode = 'HTTP_402') => {
        const state = rustStateRef.current[providerKey];
        rustStateRef.current[providerKey] = {
          ...(state ?? { providerKey, authType: 'unknown', priorityTier: 100 }),
          providerKey,
          inPool: true,
          reason: 'cooldown',
          authIssue: null,
          cooldownUntil: cooldownUntilMs,
          cooldownKeepsPool: true,
          blacklistUntil: null,
          resetAt: null,
          lastErrorSeries: 'EOTHER',
          lastErrorCode,
          lastErrorAtMs: Date.now(),
          consecutiveErrorCount: 0,
          selectionPenalty: 0,
          lastProviderGuardApplied: false
        };
      }
    })
  };
}

describe('daemon-admin quota unified special-family consistency', () => {
  jest.setTimeout(15_000);

  const originalLoginFile = process.env.ROUTECODEX_LOGIN_FILE;
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;
  let createdLoginFile: string | null = null;
  let createdTmpDir: string | null = null;

  afterEach(async () => {
    jest.resetModules();
    if (originalLoginFile === undefined) delete process.env.ROUTECODEX_LOGIN_FILE;
    else process.env.ROUTECODEX_LOGIN_FILE = originalLoginFile;
    if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
    else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;

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

  it('keeps 402/resetAt state aligned across persist/hydrate/admin and clears it on success', async () => {
    const { QuotaManager } = await import('../../../sharedmodule/llmswitch-core/src/quota/index.js');
    let activeHooks: any;

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async (options?: { store?: unknown }) => new QuotaManager(options),
      setProviderRuntimeQuotaHooks: jest.fn(async (_owner, hooks) => {
        activeHooks = hooks;
        return true;
      }),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true,
        phase2UnifiedControl: true
      },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const providerKey = 'quota.key1.gpt-test';
    const runtimeKey = 'quota.key1';
    const resetAtIso = '2026-05-28T00:00:00.000Z';
    const resetAtMs = Date.parse(resetAtIso);
    const rustStateRef = {
      current: {
        [providerKey]: {
          providerKey,
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
        }
      }
    };
    const hubPipeline = createMockHubPipeline(rustStateRef);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-resetat-special-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_QUOTA_DIR = path.join(tmpDir, 'quota');

    const mod1 = new QuotaManagerModule();
    await mod1.init({ serverId: 'test', getHubPipeline: () => hubPipeline });
    mod1.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
    await mod1.start();
    const daemon1 = { getModule: (id: string) => (id === 'quota' ? mod1 : undefined) };
    const server1 = await createAuthenticatedServer(daemon1, createdLoginFile, hubPipeline);

    try {
      activeHooks.onProviderError({
        code: 'HTTP_402',
        status: 402,
        message: `HTTP 402: {"resetAt":"${resetAtIso}"}`,
        runtime: { providerKey, runtimeKey },
        timestamp: Date.now(),
        details: { resetAt: resetAtIso }
      });
      rustStateRef.current[providerKey] = {
        ...rustStateRef.current[providerKey],
        inPool: true,
        reason: 'cooldown',
        cooldownUntil: resetAtMs,
        cooldownKeepsPool: true,
        resetAt: null,
        lastErrorSeries: 'EOTHER',
        lastErrorCode: 'HTTP_402',
        lastErrorAtMs: Date.now(),
        consecutiveErrorCount: 0,
        selectionPenalty: 0
      };

      const snapshotAfterError = mod1.getAdminSnapshot()[providerKey];
      const readOnlyAfterError = mod1.getQuotaViewReadOnly()(providerKey);
      const respAfterError = await fetch(`${server1.base}/quota/providers`, { headers: { cookie: server1.cookie } });
      const jsonAfterError = await respAfterError.json() as any;
      const adminAfterError = jsonAfterError.providers.find((entry: any) => entry.providerKey === providerKey);

      expect(snapshotAfterError).toMatchObject({
        providerKey,
        inPool: true,
        reason: 'cooldown',
        consecutiveErrorCount: 0
      });
      expect(snapshotAfterError.cooldownUntil).toBe(resetAtMs);
      expect(readOnlyAfterError).toMatchObject({
        providerKey,
        inPool: true,
        reason: 'cooldown',
        consecutiveErrorCount: 0,
        cooldownUntil: resetAtMs
      });
      expect(adminAfterError).toMatchObject({
        providerKey,
        inPool: true,
        reason: 'cooldown',
        consecutiveErrorCount: 0,
        cooldownUntil: resetAtMs
      });

      await mod1.stop();
      await server1.close();

      const mod2 = new QuotaManagerModule();
      await mod2.init({ serverId: 'test', getHubPipeline: () => hubPipeline });
      mod2.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
      await mod2.start();
      const daemon2 = { getModule: (id: string) => (id === 'quota' ? mod2 : undefined) };
      const server2 = await createAuthenticatedServer(daemon2, createdLoginFile, hubPipeline);

      try {
        const hydratedSnapshot = mod2.getAdminSnapshot()[providerKey];
        const hydratedReadOnly = mod2.getQuotaViewReadOnly()(providerKey);
        const hydratedResp = await fetch(`${server2.base}/quota/providers`, { headers: { cookie: server2.cookie } });
        const hydratedJson = await hydratedResp.json() as any;
        const hydratedAdmin = hydratedJson.providers.find((entry: any) => entry.providerKey === providerKey);

        expect(hydratedSnapshot).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'cooldown',
          consecutiveErrorCount: 0,
          cooldownUntil: resetAtMs
        });
        expect(hydratedReadOnly).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'cooldown',
          cooldownUntil: resetAtMs
        });
        expect(hydratedAdmin).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'cooldown',
          cooldownUntil: resetAtMs
        });

        activeHooks.onProviderSuccess({
          runtime: { providerKey, runtimeKey },
          timestamp: Date.now()
        });
        rustStateRef.current[providerKey] = {
          ...rustStateRef.current[providerKey],
          inPool: true,
          reason: 'active',
          cooldownUntil: null,
          blacklistUntil: null,
          authIssue: null,
          resetAt: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0
        };

        const snapshotAfterSuccess = mod2.getAdminSnapshot()[providerKey];
        const readOnlyAfterSuccess = mod2.getQuotaViewReadOnly()(providerKey);
        const respAfterSuccess = await fetch(`${server2.base}/quota/providers`, { headers: { cookie: server2.cookie } });
        const jsonAfterSuccess = await respAfterSuccess.json() as any;
        const adminAfterSuccess = jsonAfterSuccess.providers.find((entry: any) => entry.providerKey === providerKey);

        expect(snapshotAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok',
          consecutiveErrorCount: 0
        });
        expect(snapshotAfterSuccess.cooldownUntil).toBeNull();
        expect(readOnlyAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok',
          consecutiveErrorCount: 0
        });
        expect(readOnlyAfterSuccess?.cooldownUntil).toBeNull();
        expect(adminAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'active',
          consecutiveErrorCount: 0
        });
        expect(adminAfterSuccess?.cooldownUntil).toBeNull();
      } finally {
        await mod2.stop();
        await server2.close();
      }
    } finally {
      // mod1/server1 may already be closed above; ignore duplicate shutdowns.
      await Promise.resolve().catch(() => {});
    }
  });

  it('sanitizes auth/fatal persisted state on restart and keeps admin projection aligned after success', async () => {
    const { QuotaManager } = await import('../../../sharedmodule/llmswitch-core/src/quota/index.js');
    let activeHooks: any;

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async (options?: { store?: unknown }) => new QuotaManager(options),
      setProviderRuntimeQuotaHooks: jest.fn(async (_owner, hooks) => {
        activeHooks = hooks;
        return true;
      }),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true,
        phase2UnifiedControl: true
      },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const providerKey = 'auth.key1.gpt-test';
    const runtimeKey = 'auth.key1';
    const rustStateRef = {
      current: {
        [providerKey]: {
          providerKey,
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
        }
      }
    };
    const hubPipeline = createMockHubPipeline(rustStateRef);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-auth-special-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_QUOTA_DIR = path.join(tmpDir, 'quota');

    const mod1 = new QuotaManagerModule();
    await mod1.init({ serverId: 'test', getHubPipeline: () => hubPipeline });
    mod1.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100 });
    await mod1.start();
    const daemon1 = { getModule: (id: string) => (id === 'quota' ? mod1 : undefined) };
    const server1 = await createAuthenticatedServer(daemon1, createdLoginFile, hubPipeline);

    try {
      activeHooks.onProviderError({
        code: 'NEW_API_ERROR',
        status: 400,
        message: 'auth verify required',
        runtime: { providerKey, runtimeKey },
        timestamp: Date.now(),
        details: {
          authIssue: {
            kind: 'google_account_verification',
            url: 'https://example.invalid/verify'
          }
        }
      });
      rustStateRef.current[providerKey] = {
        ...rustStateRef.current[providerKey],
        inPool: false,
        reason: 'authVerify',
        authIssue: {
          kind: 'google_account_verification',
          url: 'https://example.invalid/verify'
        },
        cooldownUntil: null,
        blacklistUntil: null,
        lastErrorSeries: 'EFATAL',
        lastErrorCode: 'NEW_API_ERROR',
        lastErrorAtMs: Date.now(),
        consecutiveErrorCount: 1,
        selectionPenalty: 1
      };

      const snapshotAfterError = mod1.getAdminSnapshot()[providerKey];
      const readOnlyAfterError = mod1.getQuotaViewReadOnly()(providerKey);
      const respAfterError = await fetch(`${server1.base}/quota/providers`, { headers: { cookie: server1.cookie } });
      const jsonAfterError = await respAfterError.json() as any;
      const adminAfterError = jsonAfterError.providers.find((entry: any) => entry.providerKey === providerKey);

      expect(snapshotAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'authVerify'
      });
      expect(snapshotAfterError.authIssue).toMatchObject({
        kind: 'google_account_verification'
      });
      expect(readOnlyAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'authVerify'
      });
      expect(adminAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'authVerify'
      });

      await mod1.stop();
      await server1.close();

      const mod2 = new QuotaManagerModule();
      await mod2.init({ serverId: 'test', getHubPipeline: () => hubPipeline });
      mod2.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100 });
      await mod2.start();
      const daemon2 = { getModule: (id: string) => (id === 'quota' ? mod2 : undefined) };
      const server2 = await createAuthenticatedServer(daemon2, createdLoginFile, hubPipeline);

      try {
        const hydratedSnapshot = mod2.getAdminSnapshot()[providerKey];
        const hydratedReadOnly = mod2.getQuotaViewReadOnly()(providerKey);
        const hydratedResp = await fetch(`${server2.base}/quota/providers`, { headers: { cookie: server2.cookie } });
        const hydratedJson = await hydratedResp.json() as any;
        const hydratedAdmin = hydratedJson.providers.find((entry: any) => entry.providerKey === providerKey);

        expect(hydratedSnapshot).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok',
          consecutiveErrorCount: 0
        });
        expect(hydratedSnapshot.authIssue).toBeNull();
        expect(hydratedReadOnly).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok'
        });
        expect(hydratedReadOnly?.authIssue ?? null).toBeNull();
        expect(hydratedAdmin).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'active',
          consecutiveErrorCount: 0
        });
        expect(hydratedAdmin?.authIssue ?? null).toBeNull();

        activeHooks.onProviderSuccess({
          runtime: { providerKey, runtimeKey },
          timestamp: Date.now()
        });
        rustStateRef.current[providerKey] = {
          ...rustStateRef.current[providerKey],
          inPool: true,
          reason: 'active',
          authIssue: null,
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          selectionPenalty: 0
        };

        const snapshotAfterSuccess = mod2.getAdminSnapshot()[providerKey];
        const readOnlyAfterSuccess = mod2.getQuotaViewReadOnly()(providerKey);
        const respAfterSuccess = await fetch(`${server2.base}/quota/providers`, { headers: { cookie: server2.cookie } });
        const jsonAfterSuccess = await respAfterSuccess.json() as any;
        const adminAfterSuccess = jsonAfterSuccess.providers.find((entry: any) => entry.providerKey === providerKey);

        expect(snapshotAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok',
          consecutiveErrorCount: 0
        });
        expect(readOnlyAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'ok'
        });
        expect(adminAfterSuccess).toMatchObject({
          providerKey,
          inPool: true,
          reason: 'active',
          consecutiveErrorCount: 0
        });
      } finally {
        await mod2.stop();
        await server2.close();
      }
    } finally {
      await Promise.resolve().catch(() => {});
    }
  });
});
