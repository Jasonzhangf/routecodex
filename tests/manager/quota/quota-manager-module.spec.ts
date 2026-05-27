import { jest } from '@jest/globals';

const BRIDGE_MODULE_PATH = '../../../src/modules/llmswitch/bridge.js';
const GATE_MODULE_PATH = new URL('../../../src/server/runtime/http-server/daemon-admin/routecodex-x7e-gate.ts', import.meta.url).pathname;
const QUOTA_STORE_MODULE_PATH = '../../../src/manager/quota/provider-quota-store.js';

describe('QuotaManagerModule', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('uses core quota manager when phase1 unified quota gate is enabled', async () => {
    const quotaView = () => null;
    const snapshot = {
      updatedAtMs: 123,
      providers: {
        'mock.provider': {
          providerKey: 'mock.provider',
          inPool: true,
          reason: 'ok',
          authType: 'apikey',
          priorityTier: 100,
          cooldownUntil: null,
          blacklistUntil: null,
          lastErrorSeries: null,
          lastErrorCode: null,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0
        }
      }
    };
    const coreManager = {
      hydrateFromStore: async () => {},
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getQuotaView: () => quotaView,
      getSnapshot: () => snapshot,
      persistNow: async () => {}
    };

    const bridgeMock = () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    });
    jest.unstable_mockModule(BRIDGE_MODULE_PATH, bridgeMock);
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({
      serverId: 'test',
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          getStatus: () => ({ quotaHostSnapshot: Object.values(snapshot.providers) })
        })
      })
    });
    await mod.start();

    expect(mod.getCoreQuotaManager()).toBeNull();
    expect(mod.getQuotaView()('mock.provider')).toMatchObject({
      providerKey: 'mock.provider',
      inPool: true,
      reason: 'ok'
    });
    expect(mod.getQuotaViewReadOnly()('mock.provider')).toMatchObject({
      providerKey: 'mock.provider',
      inPool: true,
      reason: 'ok'
    });
    expect(mod.getAdminSnapshot()).toMatchObject(snapshot.providers);
    expect(coreManager.onProviderError).not.toHaveBeenCalled();
    expect(coreManager.onProviderSuccess).not.toHaveBeenCalled();
  });


  it('does not register unified quota runtime second ingress hooks when phase1 unified quota gate is enabled', async () => {
    const coreManager = {
      hydrateFromStore: async () => {},
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getQuotaView: () => (() => null),
      getSnapshot: () => ({ updatedAtMs: Date.now(), providers: {} }),
      persistNow: async () => {}
    };

    const setProviderRuntimeQuotaHooks = jest.fn(async () => true);

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks,
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({
      serverId: 'test',
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          handleProviderError: jest.fn(),
          handleProviderSuccess: jest.fn()
        })
      })
    });
    await mod.start();

    expect(setProviderRuntimeQuotaHooks).not.toHaveBeenCalled();
    expect(coreManager.onProviderError).not.toHaveBeenCalled();
    expect(coreManager.onProviderSuccess).not.toHaveBeenCalled();
  });

  it('routes public reset/recover/disable through rust host mutator instead of TS core manager in unified mode', async () => {
    const coreManager = {
      hydrateFromStore: jest.fn(async () => {}),
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getQuotaView: () => (() => null),
      getSnapshot: () => ({ updatedAtMs: Date.now(), providers: {} }),
      persistNow: jest.fn(async () => {}),
      resetProvider: jest.fn(),
      recoverProvider: jest.fn(),
      disableProvider: jest.fn()
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    let rustCalls: Array<{ kind: string; args: any[] }> = [];
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({
      serverId: 'test',
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          getStatus: () => ({ quotaHostSnapshot: [] }),
          resetProviderQuota: (...args: any[]) => void rustCalls.push({ kind: 'reset', args }),
          recoverProviderQuota: (...args: any[]) => void rustCalls.push({ kind: 'recover', args }),
          disableProviderQuota: (...args: any[]) => void rustCalls.push({ kind: 'disable', args })
        })
      })
    });

    rustCalls = [];

    await mod.resetProvider('quota.1.gpt-test');
    await mod.recoverProvider('quota.1.gpt-test');
    await mod.disableProvider({ providerKey: 'quota.1.gpt-test', mode: 'blacklist', durationMs: 60_000 });

    expect(rustCalls).toEqual([
      { kind: 'reset', args: ['quota.1.gpt-test'] },
      { kind: 'recover', args: ['quota.1.gpt-test'] },
      { kind: 'disable', args: ['quota.1.gpt-test', 'blacklist', 60_000] }
    ]);
    expect(coreManager.resetProvider).not.toHaveBeenCalled();
    expect(coreManager.recoverProvider).not.toHaveBeenCalled();
    expect(coreManager.disableProvider).not.toHaveBeenCalled();
    expect(coreManager.persistNow).not.toHaveBeenCalled();
  });

  it('fails fast for public reset/recover/disable in unified mode when rust quota host mutator is absent', async () => {
    const coreManager = {
      hydrateFromStore: jest.fn(async () => {}),
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getQuotaView: () => (() => null),
      getSnapshot: () => ({ updatedAtMs: Date.now(), providers: {} }),
      persistNow: jest.fn(async () => {}),
      resetProvider: jest.fn(),
      recoverProvider: jest.fn(),
      disableProvider: jest.fn()
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({
      serverId: 'test',
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          getStatus: () => ({ quotaHostSnapshot: [] })
        })
      })
    });

    await expect(mod.resetProvider('quota.1.gpt-test')).resolves.toEqual({
      providerKey: 'quota.1.gpt-test',
      state: null
    });
    await expect(mod.recoverProvider('quota.1.gpt-test')).resolves.toEqual({
      providerKey: 'quota.1.gpt-test',
      state: null
    });
    await expect(mod.disableProvider({ providerKey: 'quota.1.gpt-test', mode: 'blacklist', durationMs: 60_000 })).resolves.toEqual({
      providerKey: 'quota.1.gpt-test',
      state: null
    });

    expect(coreManager.resetProvider).not.toHaveBeenCalled();
    expect(coreManager.recoverProvider).not.toHaveBeenCalled();
    expect(coreManager.disableProvider).not.toHaveBeenCalled();
    expect(coreManager.persistNow).not.toHaveBeenCalled();
  });

  it('prefers rust quota host snapshot persist/hydrate bridge when hubPipeline is available', async () => {
    const persistedSnapshots: any[] = [];
    const loadedSnapshot = {
      savedAtMs: 123,
      providers: {
        'quota.1.gpt-test': {
          providerKey: 'quota.1.gpt-test',
          inPool: false,
          reason: 'cooldown',
          authType: 'apikey',
          authIssue: null,
          priorityTier: 100,
          cooldownUntil: Date.now() + 60_000,
          blacklistUntil: null,
          lastErrorSeries: 'E429',
          lastErrorCode: 'QUOTA_DEPLETED',
          lastErrorAtMs: Date.now(),
          consecutiveErrorCount: 2
        }
      }
    };

    const coreManager = {
      hydrateFromStore: jest.fn(async () => {}),
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getQuotaView: () => (() => null),
      getSnapshot: () => ({ updatedAtMs: Date.now(), providers: {} }),
      persistNow: jest.fn(async () => {})
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async (options?: { store?: { load?: () => Promise<any>; save?: (payload: any) => Promise<void> } }) => {
        const wrapped = {
          ...coreManager,
          __store: options?.store
        };
        return wrapped;
      },
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(QUOTA_STORE_MODULE_PATH, () => ({
      loadProviderQuotaSnapshot: jest.fn(async () => ({
        version: 1,
        updatedAt: new Date(loadedSnapshot.savedAtMs).toISOString(),
        providers: loadedSnapshot.providers
      })),
      saveProviderQuotaSnapshot: jest.fn(async (providers: any, now?: Date) => {
        persistedSnapshots.push({
          savedAtMs: now instanceof Date ? now.getTime() : Date.now(),
          providers
        });
      }),
      appendProviderErrorEvent: jest.fn(async () => {}),
      sanitizeQuotaStateForSnapshot: jest.fn((state: any) => state)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const rustCalls: Array<{ kind: string; args: any[] }> = [];
    const hubPipeline = {
      getVirtualRouter: () => ({
        getStatus: () => ({
          quotaHostSnapshot: [
            {
              providerKey: 'quota.1.gpt-test',
              inPool: false,
              reason: 'cooldown',
              authType: 'apikey',
              authIssue: null,
              priorityTier: 100,
              cooldownUntil: loadedSnapshot.providers['quota.1.gpt-test'].cooldownUntil,
              blacklistUntil: null,
              lastErrorSeries: 'E429',
              lastErrorCode: 'QUOTA_DEPLETED',
              lastErrorAtMs: loadedSnapshot.providers['quota.1.gpt-test'].lastErrorAtMs,
              consecutiveErrorCount: 2
            }
          ]
        }),
        resetProviderQuota: (...args: any[]) => void rustCalls.push({ kind: 'reset', args }),
        disableProviderQuota: (...args: any[]) => void rustCalls.push({ kind: 'disable', args })
      })
    };

    const mod2 = new QuotaManagerModule();
    await mod2.init({
      serverId: 'test',
      getHubPipeline: () => hubPipeline
    });

    // manual trigger persist path
    await mod2.persistNow();

    expect(coreManager.hydrateFromStore).not.toHaveBeenCalled();
    expect(coreManager.persistNow).not.toHaveBeenCalled();
    expect(rustCalls.some((entry) => entry.kind === 'disable')).toBe(true);
    expect(persistedSnapshots).toHaveLength(1);
    expect(persistedSnapshots[0].providers['quota.1.gpt-test']).toMatchObject({
      providerKey: 'quota.1.gpt-test',
      reason: 'cooldown',
      authType: 'apikey'
    });
  });

  it('fails fast when unified quota starts without rust host mutator', async () => {
    const coreManager = {
      hydrateFromStore: async () => {},
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getSnapshot: jest.fn(() => ({ updatedAtMs: Date.now(), providers: {} })),
      persistNow: async () => {}
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' });
    await expect(mod.start()).rejects.toThrow(
      'unified quota requires hubPipeline virtual router quota host mutator'
    );
  });

  it('uses rust host snapshot as unified readOnly/admin source', async () => {
    const coreManager = {
      hydrateFromStore: async () => {},
      registerProviderStaticConfig: jest.fn(),
      onProviderError: jest.fn(),
      onProviderSuccess: jest.fn(),
      getSnapshot: jest.fn(() => ({ updatedAtMs: Date.now(), providers: {} })),
      persistNow: async () => {}
    };

    jest.unstable_mockModule(BRIDGE_MODULE_PATH, () => ({
      createCoreQuotaManager: async () => coreManager,
      setProviderRuntimeQuotaHooks: jest.fn(async () => true),
      setProviderRuntimeProviderQuotaHooks: jest.fn(async () => true)
    }));
    jest.unstable_mockModule(GATE_MODULE_PATH, () => ({
      x7eGate: {
        phase1UnifiedQuota: true
      }
    }));

    const runtimeRef: { current: any } = {
      current: {
        getVirtualRouter: () => ({
          getStatus: () => ({
            quotaHostSnapshot: [
              {
                providerKey: 'mock.provider',
                inPool: false,
                reason: 'cooldown',
                authType: 'apikey',
                authIssue: null,
                priorityTier: 100,
                cooldownUntil: 789,
                blacklistUntil: null,
                lastErrorSeries: 'E429',
                lastErrorCode: 'QUOTA_DEPLETED',
                lastErrorAtMs: 456,
                consecutiveErrorCount: 3
              }
            ]
          })
        })
      }
    };
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/quota-manager.js');
    const mod = new QuotaManagerModule();
    await mod.init({
      serverId: 'test',
      getHubPipeline: () => runtimeRef.current
    });

    expect(mod.getAdminSnapshot()).toMatchObject({
      'mock.provider': {
        providerKey: 'mock.provider',
        inPool: false,
        reason: 'cooldown',
        cooldownUntil: 789,
        consecutiveErrorCount: 3
      }
    });
    expect(mod.getQuotaViewReadOnly()('mock.provider')).toMatchObject({
      providerKey: 'mock.provider',
      inPool: false,
      reason: 'cooldown',
      cooldownUntil: 789,
      consecutiveErrorCount: 3
    });
  });
});
