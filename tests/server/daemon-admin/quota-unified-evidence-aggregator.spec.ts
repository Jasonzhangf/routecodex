import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { VirtualRouterEngine } from '../../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { QuotaManager } from '../../../sharedmodule/llmswitch-core/src/quota/index.js';
import { registerDaemonAuthRoutes } from '../../../src/server/runtime/http-server/daemon-admin/auth-handler.js';
import { registerQuotaRoutes } from '../../../src/server/runtime/http-server/daemon-admin/quota-handler.js';

const BRIDGE_MODULE_PATH = '../../../src/modules/llmswitch/bridge.js';
const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;

function buildDualProviderConfig(providerA = 'quota.key1.gpt-test', providerB = 'quota.key2.gpt-test'): any {
  return {
    routing: { default: [{ id: 'default-primary', priority: 100, mode: 'priority', targets: [providerA, providerB] }] },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'quota.key1',
        modelId: 'gpt-test'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'quota.key2',
        modelId: 'gpt-test'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: { failureThreshold: 3, cooldownMs: 30_000, fatalCooldownMs: 120_000 }
  };
}

async function createAuthenticatedQuotaServer(options: {
  daemon: { getModule: (id: string) => any };
  loginFile: string;
}): Promise<{ base: string; cookie: string; close: () => Promise<void> }> {
  process.env.ROUTECODEX_LOGIN_FILE = options.loginFile;
  const app = express();
  app.use(express.json());
  registerDaemonAuthRoutes(app);
  registerQuotaRoutes(app, {
    app,
    getManagerDaemon: () => options.daemon,
    getServerId: () => 'test:0'
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

    const rustOnlyEngine = new VirtualRouterEngine({} as any);
    rustOnlyEngine.initialize(buildDualProviderConfig(providerA, providerB));
    const tsPoisonedEngine = new VirtualRouterEngine({
      quotaView: (providerKey: string) => providerKey === providerA
        ? { providerKey, inPool: false, reason: 'quotaDepleted', cooldownUntil: Date.now() + 60_000, priorityTier: 100 }
        : { providerKey, inPool: true, priorityTier: 100 }
    } as any);
    tsPoisonedEngine.initialize(buildDualProviderConfig(providerA, providerB));
    const rustOnlyDecision = rustOnlyEngine.route({ messages: [{ role: 'user', content: 'hello' }] } as any, { requestId: 'req-evidence-rust-only' } as any);
    const tsPoisonedDecision = tsPoisonedEngine.route({ messages: [{ role: 'user', content: 'hello' }] } as any, { requestId: 'req-evidence-ts-poisoned' } as any);

    const coreQuotaManager = new QuotaManager();
    coreQuotaManager.registerProviderStaticConfig(providerA, { authType: 'apikey', priorityTier: 100 });
    coreQuotaManager.onProviderError({
      code: 'HTTP_500',
      status: 500,
      message: 'upstream failure',
      runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
      timestamp: Date.now()
    } as any);
    coreQuotaManager.onProviderError({
      code: 'HTTP_500',
      status: 500,
      message: 'upstream failure',
      runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
      timestamp: Date.now() + 10_000
    } as any);
    coreQuotaManager.onProviderError({
      code: 'HTTP_500',
      status: 500,
      message: 'upstream failure',
      runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
      timestamp: Date.now() + 20_000
    } as any);
    coreQuotaManager.onProviderSuccess({
      runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
      timestamp: Date.now() + 20_001
    } as any);
    const coreRecovered = coreQuotaManager.getSnapshot().providers[providerA];

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
      x7eGate: { phase1UnifiedQuota: true, phase2UnifiedControl: true },
      getGateState: () => ({ phase1_unifiedQuota: true, phase2_unifiedControl: true })
    }));
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');

    createdTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-evidence-'));
    process.env.ROUTECODEX_QUOTA_DIR = path.join(createdTmpDir, 'quota');
    const loginFile = path.join(createdTmpDir, 'login');

    const quotaModule = new QuotaManagerModule();
    await quotaModule.init({ serverId: 'test' });
    quotaModule.registerProviderStaticConfig(providerA, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
    await quotaModule.start();
    const daemon = { getModule: (id: string) => (id === 'quota' ? quotaModule : undefined) };
    const server = await createAuthenticatedQuotaServer({ daemon, loginFile });

    try {
      const resetAtIso = '2026-05-28T00:00:00.000Z';
      const resetAtMs = Date.parse(resetAtIso);
      activeHooks.onProviderError({
        code: 'HTTP_402',
        status: 402,
        message: `HTTP 402: {"resetAt":"${resetAtIso}"}`,
        runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
        timestamp: Date.now(),
        details: { resetAt: resetAtIso }
      });

      const after402Snapshot = quotaModule.getAdminSnapshot()[providerA];
      const after402ReadOnly = quotaModule.getQuotaViewReadOnly()(providerA);
      const after402Resp = await fetch(`${server.base}/quota/providers`, { headers: { cookie: server.cookie } });
      const after402Json = await after402Resp.json() as any;
      const after402Admin = after402Json.providers.find((entry: any) => entry.providerKey === providerA);

      await quotaModule.stop();
      const quotaModuleHydrated = new QuotaManagerModule();
      await quotaModuleHydrated.init({ serverId: 'test' });
      quotaModuleHydrated.registerProviderStaticConfig(providerA, { authType: 'apikey', priorityTier: 100, apikeyDailyResetTime: '12:00Z' });
      await quotaModuleHydrated.start();
      const daemonHydrated = { getModule: (id: string) => (id === 'quota' ? quotaModuleHydrated : undefined) };
      const serverHydrated = await createAuthenticatedQuotaServer({ daemon: daemonHydrated, loginFile });

      try {
        const hydrated402Snapshot = quotaModuleHydrated.getAdminSnapshot()[providerA];
        const hydrated402ReadOnly = quotaModuleHydrated.getQuotaViewReadOnly()(providerA);
        const hydrated402Resp = await fetch(`${serverHydrated.base}/quota/providers`, { headers: { cookie: serverHydrated.cookie } });
        const hydrated402Json = await hydrated402Resp.json() as any;
        const hydrated402Admin = hydrated402Json.providers.find((entry: any) => entry.providerKey === providerA);

        activeHooks.onProviderSuccess({
          runtime: { providerKey: providerA, runtimeKey: 'quota.key1' },
          timestamp: Date.now()
        });

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

        expect(evidence.routeDecisionIndependentFromTsQuotaView).toEqual({
          rustOnly: providerA,
          tsPoisoned: providerA
        });
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
        expect(evidence.successProjectionAlignedAfterHydrate).toEqual({
          snapshot: { inPool: true, reason: 'ok', cooldownUntil: null },
          readOnly: { inPool: true, reason: 'ok', cooldownUntil: null },
          admin: { inPool: true, reason: 'ok', cooldownUntil: null }
        });
      } finally {
        await quotaModuleHydrated.stop();
        await serverHydrated.close();
      }
    } finally {
      await server.close();
    }
  });
});
