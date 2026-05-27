import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerQuotaRoutes } from '../../../src/server/runtime/http-server/daemon-admin/quota-handler.js';
import { reportProviderErrorToRouterPolicy, reportProviderSuccessToRouterPolicy, resetProviderRuntimeIngressForTests, setVirtualRouterPolicyRuntimeRouterHooks } from '../../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.js';

const BRIDGE_MODULE_PATH = '../../../src/modules/llmswitch/bridge.js';
const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

describe('daemon-admin quota unified host/rust consistency', () => {
  jest.setTimeout(10_000);

  const originalLoginFile = process.env.ROUTECODEX_LOGIN_FILE;
  let createdLoginFile: string | null = null;
  let createdTmpDir: string | null = null;

  afterEach(async () => {
    resetProviderRuntimeIngressForTests();
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

  it('keeps host snapshot, readOnly quota view, and admin /quota/providers aligned after quota exhausted then success recover', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-daemon-admin-'));
    createdTmpDir = tmpDir;
    createdLoginFile = path.join(tmpDir, 'login');
    process.env.ROUTECODEX_LOGIN_FILE = createdLoginFile;

    const providerKey = 'quota.key1.gpt-test';
    const runtimeKey = 'quota.key1';
    const stateByProviderKey: Record<string, any> = {};

    const coreManager = {
      hydrateFromStore: async () => {},
      registerProviderStaticConfig: jest.fn((key: string, cfg: any) => {
        stateByProviderKey[key] = stateByProviderKey[key] ?? {
          providerKey: key,
          inPool: true,
          reason: 'active',
          authType: cfg?.authType ?? 'apikey',
          authIssue: null,
          priorityTier: cfg?.priorityTier ?? 100,
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0
        };
      }),
      onProviderError: jest.fn((ev: any) => {
        const key = ev?.runtime?.providerKey;
        if (!key) return;
        stateByProviderKey[key] = {
          ...(stateByProviderKey[key] ?? {
            providerKey: key,
            authType: 'apikey',
            authIssue: null,
            priorityTier: 100
          }),
          providerKey: key,
          inPool: false,
          reason: 'quotaDepleted',
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorAtMs: typeof ev?.timestamp === 'number' ? ev.timestamp : Date.now(),
          consecutiveErrorCount: 1
        };
      }),
      onProviderSuccess: jest.fn((ev: any) => {
        const key = ev?.runtime?.providerKey;
        if (!key) return;
        stateByProviderKey[key] = {
          ...(stateByProviderKey[key] ?? {
            providerKey: key,
            authType: 'apikey',
            authIssue: null,
            priorityTier: 100
          }),
          providerKey: key,
          inPool: true,
          reason: 'active',
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0
        };
      }),
      getQuotaView: () => (key: string) => {
        const state = stateByProviderKey[key];
        return state ? { ...state } : null;
      },
      getSnapshot: () => ({
        updatedAtMs: Date.now(),
        providers: { ...stateByProviderKey }
      }),
      persistNow: async () => {}
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
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

    const quotaModule = new QuotaManagerModule();
    const hubPipeline = {
      getVirtualRouter: () => ({
        getStatus: () => ({
          quotaHostSnapshot: Object.values(stateByProviderKey).map((state) => ({
            providerKey: state.providerKey,
            inPool: state.inPool,
            reason: state.reason,
            authType: state.authType,
            authIssue: state.authIssue,
            priorityTier: state.priorityTier,
            cooldownUntil: state.cooldownUntil,
            blacklistUntil: state.blacklistUntil,
            lastErrorAtMs: state.lastErrorAtMs,
            consecutiveErrorCount: state.consecutiveErrorCount
          }))
        }),
        resetProviderQuota: (providerKey: string) => {
          const state = stateByProviderKey[providerKey];
          if (!state) return;
          stateByProviderKey[providerKey] = { ...state, inPool: true, reason: 'active', cooldownUntil: null, blacklistUntil: null };
        },
        recoverProviderQuota: (providerKey: string) => {
          const state = stateByProviderKey[providerKey];
          if (!state) return;
          stateByProviderKey[providerKey] = { ...state, inPool: true, reason: 'active', cooldownUntil: null, blacklistUntil: null };
        },
        disableProviderQuota: (providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number) => {
          const state = stateByProviderKey[providerKey];
          if (!state) return;
          const until = Date.now() + Math.max(1, durationMs);
          stateByProviderKey[providerKey] = mode === 'blacklist'
            ? { ...state, inPool: false, reason: 'blacklist', blacklistUntil: until }
            : { ...state, inPool: false, reason: 'cooldown', cooldownUntil: until };
        },
        handleProviderError: (event: any) => void coreManager.onProviderError(event),
        handleProviderSuccess: (event: any) => void coreManager.onProviderSuccess(event)
      })
    };
    const routerHookOwner = {};
    setVirtualRouterPolicyRuntimeRouterHooks(routerHookOwner, {
      handleProviderError: (event: any) => void coreManager.onProviderError(event),
      handleProviderSuccess: (event: any) => void coreManager.onProviderSuccess(event)
    });
    await quotaModule.init({ serverId: 'test', getHubPipeline: () => hubPipeline });
    quotaModule.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100 });
    await quotaModule.start();

    const daemon = {
      getModule: (id: string) => {
        if (id === 'quota') return quotaModule as any;
        return undefined;
      }
    };

    const app = express();
    app.use(express.json());
    registerDaemonAuthRoutes(app);
    registerQuotaRoutes(app, {
      app,
      getManagerDaemon: () => daemon,
      getServerId: () => 'test:0',
      getHubPipeline: () => hubPipeline
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

      reportProviderErrorToRouterPolicy({
        code: 'QUOTA_DEPLETED',
        message: 'HTTP 429: quota exhausted',
        status: 429,
        quotaScope: 'daily',
        quotaReason: 'quota_exhausted',
        resetAt: '2026-05-28T00:00:00.000Z',
        runtime: {
          requestId: 'req-quota-host-admin-before',
          routeName: 'default',
          providerKey,
          runtimeKey
        },
        timestamp: Date.now()
      });

      const snapshotAfterError = quotaModule.getAdminSnapshot()[providerKey];
      const readOnlyAfterError = quotaModule.getQuotaViewReadOnly()(providerKey);
      const providersAfterErrorResp = await fetch(`${base}/quota/providers`, {
        headers: { cookie: String(cookie) }
      });
      expect(providersAfterErrorResp.status).toBe(200);
      const providersAfterError = await providersAfterErrorResp.json() as any;
      const adminAfterError = providersAfterError.providers.find((entry: any) => entry.providerKey === providerKey);

      expect(snapshotAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'quotaDepleted',
        consecutiveErrorCount: 1
      });
      expect(readOnlyAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'quotaDepleted',
        consecutiveErrorCount: 1
      });
      expect(adminAfterError).toMatchObject({
        providerKey,
        inPool: false,
        reason: 'quotaDepleted',
        consecutiveErrorCount: 1,
        schema: 'v2',
        updatedVia: 'unified_control'
      });

      reportProviderSuccessToRouterPolicy({
        runtime: {
          requestId: 'req-quota-host-admin-after',
          providerKey,
          runtimeKey
        },
        timestamp: Date.now()
      });

      const snapshotAfterSuccess = quotaModule.getAdminSnapshot()[providerKey];
      const readOnlyAfterSuccess = quotaModule.getQuotaViewReadOnly()(providerKey);
      const providersAfterSuccessResp = await fetch(`${base}/quota/providers`, {
        headers: { cookie: String(cookie) }
      });
      expect(providersAfterSuccessResp.status).toBe(200);
      const providersAfterSuccess = await providersAfterSuccessResp.json() as any;
      const adminAfterSuccess = providersAfterSuccess.providers.find((entry: any) => entry.providerKey === providerKey);

      expect(snapshotAfterSuccess).toMatchObject({
        providerKey,
        inPool: true,
        consecutiveErrorCount: 0
      });
      expect(['ok', 'active']).toContain(snapshotAfterSuccess?.reason);
      expect(readOnlyAfterSuccess).toMatchObject({
        providerKey,
        inPool: true,
        consecutiveErrorCount: 0
      });
      expect(['ok', 'active']).toContain(readOnlyAfterSuccess?.reason);
      expect(adminAfterSuccess).toMatchObject({
        providerKey,
        inPool: true,
        consecutiveErrorCount: 0,
        schema: 'v2',
        updatedVia: 'unified_control'
      });
      expect(['ok', 'active']).toContain(adminAfterSuccess?.reason);
    } finally {
      setVirtualRouterPolicyRuntimeRouterHooks(routerHookOwner, undefined);
      await quotaModule.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
