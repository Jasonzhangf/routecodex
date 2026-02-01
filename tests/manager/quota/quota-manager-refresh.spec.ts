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

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  getProviderErrorCenter: async () => ({ emit: () => {} }),
  extractAntigravityGeminiSessionId: () => undefined,
  cacheAntigravitySessionSignature: () => {},
  lookupAntigravitySessionSignatureEntry: () => undefined,
  getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
  resetAntigravitySessionSignatureCachesForTests: () => {},
  warmupAntigravitySessionSignatureModule: async () => {}
}));

describe('QuotaManagerModule refresh behavior', () => {
  const originalHome = process.env.HOME;
  let tempHome: string | null = null;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-home-'));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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
});
