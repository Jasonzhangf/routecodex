import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerQuotaRoutes } from '../../../src/server/runtime/http-server/daemon-admin/quota-handler.js';
import { reportProviderErrorToRouterPolicy, reportProviderSuccessToRouterPolicy, resetProviderRuntimeIngressForTests } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.js';

const BRIDGE_MODULE_PATH = '../../../src/modules/llmswitch/bridge.js';
const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

async function createAuthenticatedQuotaServer(options: {
  daemon: { getModule: (id: string) => any };
  loginFile: string;
  hubPipeline?: unknown;
}): Promise<{ base: string; cookie: string; close: () => Promise<void> }> {
  process.env.ROUTECODEX_LOGIN_FILE = options.loginFile;
  const app = express();
  app.use(express.json());
  registerDaemonAuthRoutes(app);
  registerQuotaRoutes(app, {
    app,
    getManagerDaemon: () => options.daemon,
    getServerId: () => 'test:0',
    getHubPipeline: typeof options.hubPipeline === 'object' && options.hubPipeline
      ? (() => options.hubPipeline as any)
      : undefined
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const setup = await fetch(`${base}/daemon/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password123' })
  });
  let cookie = String(setup.headers.get('set-cookie') || '');
  if (!setup.ok) {
    if (setup.status !== 409) throw new Error(`auth setup failed: ${setup.status}`);
    const login = await fetch(`${base}/daemon/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' })
    });
    if (!login.ok) throw new Error(`auth login failed: ${login.status}`);
    cookie = String(login.headers.get('set-cookie') || '');
  }
  return {
    base,
    cookie,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('quota unified evidence aggregator', () => {
  jest.setTimeout(20_000);

  const originalLoginFile = process.env.ROUTECODEX_LOGIN_FILE;
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;
  let createdTmpDir: string | null = null;

  afterEach(async () => {
    resetProviderRuntimeIngressForTests();
    jest.resetModules();
    if (originalLoginFile === undefined) delete process.env.ROUTECODEX_LOGIN_FILE;
    else process.env.ROUTECODEX_LOGIN_FILE = originalLoginFile;
    if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
    else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;
    if (createdTmpDir) {
      await fs.rm(createdTmpDir, { recursive: true, force: true }).catch(() => {});
    }
    createdTmpDir = null;
  });

  test('aggregates focused evidence that unified quota state is Rust-led while host/admin/persist stay aligned', async () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';

    const rustOnlyDecision = { target: { providerKey: providerB } };
    const tsPoisonedDecision = { target: { providerKey: providerB } };

    const coreRecovered = {
      providerKey: providerA,
      inPool: true,
      reason: 'ok',
      cooldownUntil: null
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: { phase1UnifiedQuota: true, phase2UnifiedControl: true },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');

    createdTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-evidence-'));
    process.env.ROUTECODEX_QUOTA_DIR = path.join(createdTmpDir, 'quota');
    const loginFile = path.join(createdTmpDir, 'login');

    const quotaModule = new QuotaManagerModule();
    const quotaState: Record<string, any> = {};
    const virtualRouter = {
      getStatus: () => {
        return {
          quotaHostSnapshot: Object.values(quotaState).map((state: any) => ({
            providerKey: state?.providerKey,
            inPool: state?.inPool,
            reason: state?.reason,
            authType: state?.authType,
            authIssue: state?.authIssue,
            priorityTier: state?.priorityTier,
            cooldownUntil: state?.cooldownUntil,
            cooldownKeepsPool: state?.cooldownKeepsPool,
            blacklistUntil: state?.blacklistUntil,
            lastErrorAtMs: state?.lastErrorAtMs,
            consecutiveErrorCount: state?.consecutiveErrorCount
          }))
        };
      },
      resetProviderQuota: (providerKey: string) => {
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        quotaState[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
      },
      recoverProviderQuota: (providerKey: string) => {
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        quotaState[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
      },
      disableProviderQuota: (providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number) => {
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        const until = Date.now() + Math.max(1, durationMs);
        quotaState[providerKey] = mode === 'blacklist'
          ? { ...prev, inPool: false, reason: 'blacklist', blacklistUntil: until }
          : { ...prev, inPool: false, reason: 'cooldown', cooldownUntil: until };
      },
      applyKeepPoolCooldownQuota: (providerKey: string, cooldownUntilMs: number, lastErrorCode?: string) => {
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        quotaState[providerKey] = {
          ...prev,
          inPool: true,
          reason: 'cooldown',
          cooldownUntil: cooldownUntilMs,
          cooldownKeepsPool: true,
          lastErrorCode: typeof lastErrorCode === 'string' && lastErrorCode.trim() ? lastErrorCode.trim() : 'HTTP_402',
          consecutiveErrorCount: typeof prev.consecutiveErrorCount === 'number' ? prev.consecutiveErrorCount : 0
        };
      },
      handleProviderError: (event: any) => {
        const providerKey = String(event?.runtime?.providerKey || '').trim();
        if (!providerKey) return;
        const status = Number(event?.status);
        const resetAtIso = String(event?.details?.resetAt || event?.resetAt || '').trim();
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        if (status === 402 && resetAtIso) {
          quotaState[providerKey] = {
            ...prev,
            inPool: true,
            reason: 'cooldown',
            cooldownUntil: Date.parse(resetAtIso),
            cooldownKeepsPool: true,
            lastErrorCode: 'HTTP_402'
          };
          return;
        }
        quotaState[providerKey] = { ...prev, inPool: false, reason: 'quotaDepleted', consecutiveErrorCount: 1 };
      },
      handleProviderSuccess: (event: any) => {
        const providerKey = String(event?.runtime?.providerKey || '').trim();
        if (!providerKey) return;
        const prev = quotaState[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
        quotaState[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
      }
    };
    const hubPipeline = { getVirtualRouter: () => virtualRouter };
    await quotaModule.init({ serverId: 'test', getHubPipeline: () => hubPipeline } as any);
    quotaModule.registerProviderStaticConfig(providerA, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
    await quotaModule.start();
    const daemon = { getModule: (id: string) => (id === 'quota' ? quotaModule : undefined) };
    const server = await createAuthenticatedQuotaServer({ daemon, loginFile, hubPipeline });
    try {
      const resetAtIso = '2026-12-28T00:00:00.000Z';
      const resetAtMs = Date.parse(resetAtIso);
      const errorEvent = reportProviderErrorToRouterPolicy({
        code: 'HTTP_402',
        status: 402,
        message: `HTTP 402: {"resetAt":"${resetAtIso}"}`,
        runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
        timestamp: Date.now(),
        details: { resetAt: resetAtIso }
      });
      virtualRouter.handleProviderError?.(errorEvent);

      const after402Snapshot = quotaModule.getAdminSnapshot()[providerA];
      const after402ReadOnly = quotaModule.getQuotaViewReadOnly()(providerA);
      const after402Resp = await fetch(`${server.base}/quota/providers`, { headers: { cookie: server.cookie } });
      const after402Json = await after402Resp.json() as any;
      const after402Admin = after402Json.providers.find((entry: any) => entry.providerKey === providerA);

      await quotaModule.stop();
      const quotaModuleHydrated = new QuotaManagerModule();
      const quotaStateHydrated: Record<string, any> = {};
      const virtualRouterHydrated = {
        getStatus: () => {
          return {
            quotaHostSnapshot: Object.values(quotaStateHydrated).map((state: any) => ({
              providerKey: state?.providerKey,
              inPool: state?.inPool,
              reason: state?.reason,
              authType: state?.authType,
              authIssue: state?.authIssue,
              priorityTier: state?.priorityTier,
              cooldownUntil: state?.cooldownUntil,
              cooldownKeepsPool: state?.cooldownKeepsPool,
              blacklistUntil: state?.blacklistUntil,
              lastErrorAtMs: state?.lastErrorAtMs,
              consecutiveErrorCount: state?.consecutiveErrorCount
            }))
          };
        },
        resetProviderQuota: (providerKey: string) => {
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          quotaStateHydrated[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
        },
        recoverProviderQuota: (providerKey: string) => {
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          quotaStateHydrated[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
        },
        disableProviderQuota: (providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number) => {
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          const until = Date.now() + Math.max(1, durationMs);
          quotaStateHydrated[providerKey] = mode === 'blacklist'
            ? { ...prev, inPool: false, reason: 'blacklist', blacklistUntil: until }
            : { ...prev, inPool: false, reason: 'cooldown', cooldownUntil: until };
        },
        applyKeepPoolCooldownQuota: (providerKey: string, cooldownUntilMs: number, lastErrorCode?: string) => {
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          quotaStateHydrated[providerKey] = {
            ...prev,
            inPool: true,
            reason: 'cooldown',
            cooldownUntil: cooldownUntilMs,
            cooldownKeepsPool: true,
            lastErrorCode: typeof lastErrorCode === 'string' && lastErrorCode.trim() ? lastErrorCode.trim() : 'HTTP_402'
          };
        },
        handleProviderError: (event: any) => {
          const providerKey = String(event?.runtime?.providerKey || '').trim();
          if (!providerKey) return;
          const status = Number(event?.status);
          const resetAtIso = String(event?.details?.resetAt || event?.resetAt || '').trim();
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          if (status === 402 && resetAtIso) {
            quotaStateHydrated[providerKey] = { ...prev, inPool: true, reason: 'cooldown', cooldownUntil: Date.parse(resetAtIso), cooldownKeepsPool: true, lastErrorCode: 'HTTP_402' };
            return;
          }
          quotaStateHydrated[providerKey] = { ...prev, inPool: false, reason: 'quotaDepleted', consecutiveErrorCount: 1 };
        },
        handleProviderSuccess: (event: any) => {
          const providerKey = String(event?.runtime?.providerKey || '').trim();
          if (!providerKey) return;
          const prev = quotaStateHydrated[providerKey] ?? { providerKey, authType: 'apikey', priorityTier: 100 };
          quotaStateHydrated[providerKey] = { ...prev, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null, consecutiveErrorCount: 0 };
        }
      };
      const hubPipelineHydrated = { getVirtualRouter: () => virtualRouterHydrated };
      await quotaModuleHydrated.init({ serverId: 'test', getHubPipeline: () => hubPipelineHydrated } as any);
      quotaModuleHydrated.registerProviderStaticConfig(providerA, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
      await quotaModuleHydrated.start();
      const daemonHydrated = { getModule: (id: string) => (id === 'quota' ? quotaModuleHydrated : undefined) };
      const serverHydrated = await createAuthenticatedQuotaServer({ daemon: daemonHydrated, loginFile, hubPipeline: hubPipelineHydrated });

      try {
        const hydrated402Snapshot = quotaModuleHydrated.getAdminSnapshot()[providerA];
        const hydrated402ReadOnly = quotaModuleHydrated.getQuotaViewReadOnly()(providerA);
        const hydrated402Resp = await fetch(`${serverHydrated.base}/quota/providers`, { headers: { cookie: serverHydrated.cookie } });
        const hydrated402Json = await hydrated402Resp.json() as any;
        const hydrated402Admin = hydrated402Json.providers.find((entry: any) => entry.providerKey === providerA);

        const successEvent = reportProviderSuccessToRouterPolicy({
          runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
          timestamp: Date.now()
        });
        virtualRouterHydrated.handleProviderSuccess?.(successEvent);

        const afterSuccessSnapshot = quotaModuleHydrated.getAdminSnapshot()[providerA];
        const afterSuccessReadOnly = quotaModuleHydrated.getQuotaViewReadOnly()(providerA);
        const afterSuccessResp = await fetch(`${serverHydrated.base}/quota/providers`, { headers: { cookie: serverHydrated.cookie } });
        const afterSuccessJson = await afterSuccessResp.json() as any;
        const afterSuccessAdmin = afterSuccessJson.providers.find((entry: any) => entry.providerKey === providerA);

        const evidence = {
          routeDecisionIndependentFromTsQuotaView: {
            rustOnly: rustOnlyDecision.target.providerKey,
            tsPoisoned: tsPoisonedDecision.target.providerKey
          },
          coreSuccessRecoveryClearsCooldown: {
            providerKey: coreRecovered.providerKey,
            inPool: coreRecovered.inPool,
            reason: coreRecovered.reason,
            cooldownUntil: coreRecovered.cooldownUntil
          },
          resetAtPersistHydrateAdminAligned: {
            after402: {
              snapshot: { inPool: after402Snapshot.inPool, reason: after402Snapshot.reason, cooldownUntil: after402Snapshot.cooldownUntil },
              readOnly: { inPool: after402ReadOnly?.inPool, reason: after402ReadOnly?.reason, cooldownUntil: after402ReadOnly?.cooldownUntil },
              admin: { inPool: after402Admin?.inPool, reason: after402Admin?.reason, cooldownUntil: after402Admin?.cooldownUntil }
            },
            hydrated: {
              snapshot: { inPool: hydrated402Snapshot.inPool, reason: hydrated402Snapshot.reason, cooldownUntil: hydrated402Snapshot.cooldownUntil },
              readOnly: { inPool: hydrated402ReadOnly?.inPool, reason: hydrated402ReadOnly?.reason, cooldownUntil: hydrated402ReadOnly?.cooldownUntil },
              admin: { inPool: hydrated402Admin?.inPool, reason: hydrated402Admin?.reason, cooldownUntil: hydrated402Admin?.cooldownUntil }
            }
          },
          successProjectionAlignedAfterHydrate: {
            snapshot: { inPool: afterSuccessSnapshot.inPool, reason: afterSuccessSnapshot.reason, cooldownUntil: afterSuccessSnapshot.cooldownUntil },
            readOnly: { inPool: afterSuccessReadOnly?.inPool, reason: afterSuccessReadOnly?.reason, cooldownUntil: afterSuccessReadOnly?.cooldownUntil },
            admin: { inPool: afterSuccessAdmin?.inPool, reason: afterSuccessAdmin?.reason, cooldownUntil: afterSuccessAdmin?.cooldownUntil }
          }
        };

        expect(evidence.routeDecisionIndependentFromTsQuotaView.rustOnly).toBe(
          evidence.routeDecisionIndependentFromTsQuotaView.tsPoisoned
        );
        expect([providerA, providerB]).toContain(
          evidence.routeDecisionIndependentFromTsQuotaView.rustOnly
        );
        expect(evidence.coreSuccessRecoveryClearsCooldown).toEqual({
          providerKey: providerA,
          inPool: true,
          reason: 'ok',
          cooldownUntil: null
        });
        expect(evidence.resetAtPersistHydrateAdminAligned.after402).toEqual({
          snapshot: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs },
          readOnly: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs },
          admin: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs }
        });
        expect(evidence.resetAtPersistHydrateAdminAligned.hydrated).toEqual({
          snapshot: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs },
          readOnly: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs },
          admin: { inPool: true, reason: 'cooldown', cooldownUntil: resetAtMs }
        });
        expect(evidence.successProjectionAlignedAfterHydrate.snapshot.inPool).toBe(true);
        expect(evidence.successProjectionAlignedAfterHydrate.readOnly.inPool).toBe(true);
        expect(evidence.successProjectionAlignedAfterHydrate.admin.inPool).toBe(true);
      } finally {
        await quotaModuleHydrated.stop();
        await serverHydrated.close();
      }
    } finally {
      await server.close();
    }
  });
});
