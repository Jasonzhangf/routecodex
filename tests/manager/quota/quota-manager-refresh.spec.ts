import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fetchAntigravityQuotaSnapshot = jest.fn(async () => ({
  fetchedAt: Date.now(),
  models: {
    'claude-sonnet-4-5': { remainingFraction: 1, resetTimeRaw: new Date(Date.now() + 3600_000).toISOString() }
  }
}));
const loadAntigravityAccessToken = jest.fn(async () => 'token');
jest.unstable_mockModule('../../../src/providers/core/runtime/antigravity-quota-client.js', () => ({
  loadAntigravityAccessToken,
  fetchAntigravityQuotaSnapshot
}));

const scanProviderTokenFiles = jest.fn(async () => [{ filePath: '/tmp/token1.json', sequence: 1, alias: 'a1' }]);
jest.unstable_mockModule('../../../src/providers/auth/token-scanner/index.js', () => ({
  scanProviderTokenFiles
}));

jest.unstable_mockModule('../../../src/providers/auth/antigravity-userinfo-helper.js', () => ({
  resolveAntigravityApiBase: () => 'https://example.invalid'
}));

const clearAntigravitySessionAliasPins = jest.fn(() => ({ clearedBySession: 0, clearedByAlias: 0 }));
const hydratedStoreSnapshots: unknown[] = [];

const mockLlmsBridgeModule = () => ({
  createCoreQuotaManager: async (options?: { store?: { load?: () => Promise<unknown>; save?: (snapshot: unknown) => Promise<void> } }) => {
    const store = options?.store;
    const poolState = new Map<string, unknown>();
    const staticCfg = new Map<string, unknown>();
    return {
      hydrateFromStore: async () => {
        const loaded = await store?.load?.();
        hydratedStoreSnapshots.push(loaded ?? null);
      },
      registerProviderStaticConfig: (providerKey: string, cfg: unknown) => {
        staticCfg.set(providerKey, cfg);
      },
      onProviderError: () => {},
      onProviderSuccess: () => {},
      updateProviderPoolState: (options: { providerKey: string }) => {
        poolState.set(options.providerKey, options);
      },
      disableProvider: (options: { providerKey: string }) => {
        poolState.set(options.providerKey, options);
      },
      recoverProvider: (providerKey: string) => {
        poolState.delete(providerKey);
      },
      resetProvider: (providerKey: string) => {
        poolState.delete(providerKey);
      },
      getQuotaView: () => (providerKey: string) => poolState.get(providerKey),
      getSnapshot: () => ({
        poolState: Object.fromEntries(poolState.entries()),
        staticCfg: Object.fromEntries(staticCfg.entries())
      }),
      persistNow: async () => {
        await store?.save?.({ savedAtMs: Date.now(), providers: {} });
      }
    };
  },
  getProviderErrorCenter: async () => ({ emit: () => {} }),
  extractAntigravityGeminiSessionId: () => undefined,
  cacheAntigravitySessionSignature: () => {},
  lookupAntigravitySessionSignatureEntry: () => undefined,
  getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
  clearAntigravitySessionAliasPins,
  resetAntigravitySessionSignatureCachesForTests: () => {},
  warmupAntigravitySessionSignatureModule: async () => {}
});
// Jest ESM resolver sometimes maps `.js` imports to the `.ts` source file.
// Mock both to ensure the QuotaManagerModule sees this stubbed bridge.
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockLlmsBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockLlmsBridgeModule);

describe('QuotaManagerModule refresh behavior', () => {
  const originalHome = process.env.HOME;
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;
  const originalQuotaDirCompat = process.env.RCC_QUOTA_DIR;
  let tempHome: string | null = null;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-home-'));
    process.env.HOME = tempHome;
    process.env.ROUTECODEX_QUOTA_DIR = path.join(tempHome, '.routecodex', 'quota');
    process.env.RCC_QUOTA_DIR = process.env.ROUTECODEX_QUOTA_DIR;
    clearAntigravitySessionAliasPins.mockClear();
    hydratedStoreSnapshots.length = 0;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
    else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;
    if (originalQuotaDirCompat === undefined) delete process.env.RCC_QUOTA_DIR;
    else process.env.RCC_QUOTA_DIR = originalQuotaDirCompat;
    if (tempHome) {
      try {
        await fs.rm(tempHome, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempHome = null;
  });

  it('supports refreshNow and schedules periodic refresh (5min base)', async () => {
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();

    // Seed a legacy snapshot entry from older builds (sequence-prefixed alias).
    // refreshNow must prune it so admin views don't show duplicate/stale keys.
    const snapPath = path.join(tempHome as string, '.routecodex', 'state', 'quota', 'antigravity.json');
    await fs.mkdir(path.dirname(snapPath), { recursive: true });
    await fs.writeFile(
      snapPath,
      JSON.stringify(
        {
          'antigravity://1-a1/claude-sonnet-4-5': { remainingFraction: 0, fetchedAt: Date.now() }
        },
        null,
        2
      ),
      'utf8'
    );

    await mod.init({ serverId: 'test' } as any);

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    try {
      const out = await mod.refreshNow();
      expect(out).toHaveProperty('refreshedAt');
      expect(out).toHaveProperty('tokenCount');

      // Snapshot should exist in-memory, and alias must NOT be prefixed with sequence number.
      const snapRaw = mod.getRawSnapshot() as Record<string, unknown>;
      const keys = Object.keys(snapRaw);
      expect(keys.some((k) => k.startsWith('antigravity://a1/'))).toBe(true);
      expect(keys.some((k) => k.startsWith('antigravity://1-a1/'))).toBe(false);

      // scheduleNextRefresh is invoked via `void` in start(); call it directly for deterministic assertion.
      await (mod as any).scheduleNextRefresh();
      expect(setTimeoutSpy).toHaveBeenCalled();
      const calls = setTimeoutSpy.mock.calls;
      const last = calls[calls.length - 1];
      const delay = last?.[1] as number;
      expect(typeof delay).toBe('number');
      expect(delay).toBeLessThanOrEqual(5 * 60 * 1000);
    } finally {
      setTimeoutSpy.mockRestore();
      await mod.stop();
    }
  });

  it('refreshes once on start()', async () => {
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' } as any);
    fetchAntigravityQuotaSnapshot.mockClear();

    try {
      await mod.start();
      expect(fetchAntigravityQuotaSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await mod.stop();
    }
  });

  it('hydrates persisted cooldown/blacklist entries from quota-manager snapshot on init', async () => {
    const quotaDir = path.join(tempHome as string, '.routecodex', 'quota');
    await fs.mkdir(quotaDir, { recursive: true });
    await fs.writeFile(
      path.join(quotaDir, 'quota-manager.json'),
      JSON.stringify({
        savedAtMs: Date.now(),
        providers: {
          'antigravity.a1.claude-sonnet-4-5': {
            providerKey: 'antigravity.a1.claude-sonnet-4-5',
            inPool: false,
            reason: 'cooldown',
            cooldownUntil: Date.now() + 120_000,
            blacklistUntil: null
          },
          'antigravity.a1.gemini-3-pro-high': {
            providerKey: 'antigravity.a1.gemini-3-pro-high',
            inPool: false,
            reason: 'blacklist',
            cooldownUntil: null,
            blacklistUntil: Date.now() + 300_000
          }
        }
      }, null, 2),
      'utf8'
    );

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' } as any);
    try {
      expect(hydratedStoreSnapshots.length).toBeGreaterThan(0);
      const latest = hydratedStoreSnapshots[hydratedStoreSnapshots.length - 1] as any;
      expect(latest).toBeTruthy();
      expect(latest.providers['antigravity.a1.claude-sonnet-4-5'].cooldownUntil).toBeTruthy();
      expect(latest.providers['antigravity.a1.gemini-3-pro-high'].blacklistUntil).toBeTruthy();
    } finally {
      await mod.stop();
    }
  });

  it('projects token protected_models into quotaView and keeps antigravity model out of pool', async () => {
    const authDir = path.join(tempHome as string, 'auth');
    await fs.mkdir(authDir, { recursive: true });
    const tokenFile = path.join(authDir, 'antigravity-oauth-1-a1.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ access_token: 'token-a1', protected_models: ['claude'] }, null, 2),
      'utf8'
    );
    scanProviderTokenFiles.mockResolvedValue([{ filePath: tokenFile, sequence: 1, alias: 'a1' }]);

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' } as any);
    try {
      mod.registerProviderStaticConfig('antigravity.a1.claude-sonnet-4-5-thinking', { authType: 'oauth' });
      const view1 = mod.getQuotaView();
      const entry1 = view1('antigravity.a1.claude-sonnet-4-5-thinking') as Record<string, unknown> | null;
      expect(entry1?.inPool).toBe(false);
      expect(entry1?.reason).toBe('protected');
      expect(mod.hasQuotaForAntigravity('antigravity.a1.claude-sonnet-4-5-thinking', 'claude-sonnet-4-5-thinking')).toBe(false);

      await fs.writeFile(
        tokenFile,
        JSON.stringify({ access_token: 'token-a1', protected_models: [] }, null, 2),
        'utf8'
      );
      await (mod as any).syncAntigravityTokensFromDisk();
      const view2 = mod.getQuotaView();
      const entry2 = view2('antigravity.a1.claude-sonnet-4-5-thinking') as Record<string, unknown> | null;
      expect(entry2?.reason).toBe('quotaDepleted');
      expect(entry2?.inPool).toBe(false);
    } finally {
      await mod.stop();
    }
  });

  it('prunes persisted aliases that have no token file (no phantom alias)', async () => {
    // Simulate: legacy state has alias a1, but current token scan only has alias b2.
    scanProviderTokenFiles.mockResolvedValueOnce([{ filePath: '/tmp/token2.json', sequence: 2, alias: 'b2' }]);

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();

    const snapPath = path.join(tempHome as string, '.routecodex', 'state', 'quota', 'antigravity.json');
    await fs.mkdir(path.dirname(snapPath), { recursive: true });
    await fs.writeFile(
      snapPath,
      JSON.stringify(
        {
          'antigravity://a1/claude-sonnet-4-5': { remainingFraction: 1, fetchedAt: Date.now() }
        },
        null,
        2
      ),
      'utf8'
    );

    await mod.init({ serverId: 'test' } as any);

    try {
      const snapRaw = mod.getRawSnapshot() as Record<string, unknown>;
      const keys = Object.keys(snapRaw);
      expect(keys.some((k) => k.startsWith('antigravity://a1/'))).toBe(false);

      // Persisted file should also be cleaned.
      const onDisk = JSON.parse(await fs.readFile(snapPath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(onDisk).some((k) => k.startsWith('antigravity://a1/'))).toBe(false);
    } finally {
      await mod.stop();
    }
  });

  it('clears antigravity session bindings when quota store snapshot is missing at startup', async () => {
    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' } as any);
    try {
      expect(clearAntigravitySessionAliasPins).toHaveBeenCalledTimes(1);
      expect(clearAntigravitySessionAliasPins).toHaveBeenCalledWith({ hydrate: true });
    } finally {
      await mod.stop();
    }
  });

  it('clears antigravity session bindings when quota store persistence fails on save', async () => {
    const quotaDir = path.join(tempHome as string, '.routecodex', 'quota');
    await fs.mkdir(quotaDir, { recursive: true });
    await fs.mkdir(path.join(quotaDir, 'quota-manager.json'), { recursive: true });
    await fs.writeFile(
      path.join(quotaDir, 'provider-quota.json'),
      JSON.stringify({ savedAtMs: Date.now(), providers: {} }, null, 2),
      'utf8'
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { QuotaManagerModule } = await import('../../../src/manager/modules/quota/index.js');
    const mod = new QuotaManagerModule();
    await mod.init({ serverId: 'test' } as any);
    const mgr = mod.getCoreQuotaManager() as { persistNow?: () => Promise<void> } | null;
    try {
      clearAntigravitySessionAliasPins.mockClear();
      await mgr?.persistNow?.();
      expect(clearAntigravitySessionAliasPins).toHaveBeenCalledTimes(1);
      expect(clearAntigravitySessionAliasPins).toHaveBeenCalledWith({ hydrate: true });
      expect(warnSpy).toHaveBeenCalled();
      const logged = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain('persistence issue');
      expect(logged).toContain('quota_store_save_error');
    } finally {
      warnSpy.mockRestore();
      await mod.stop();
    }
  });
});
