import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { loadProviderQuotaSnapshot, saveProviderQuotaSnapshot } from '../../../src/manager/quota/provider-quota-store.js';
import { QuotaManager } from '../../../sharedmodule/llmswitch-core/src/quota/index.js';

describe('provider-quota-store success recovery persistence', () => {
  const originalQuotaDir = process.env.ROUTECODEX_QUOTA_DIR;

  test('persisted snapshot after success no longer retains prior cooldown residue', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-quota-success-recovery-'));
    process.env.ROUTECODEX_QUOTA_DIR = tempDir;

    try {
      const providerKey = 'quota.key1.gpt-test';
      const baseNow = Date.now();
      const manager = new QuotaManager();
      manager.registerProviderStaticConfig(providerKey, { authType: 'apikey', priorityTier: 100 });

      manager.onProviderError({
        code: 'HTTP_500',
        status: 500,
        message: 'upstream failure',
        runtime: { providerKey, runtimeKey: 'quota.key1' },
        timestamp: baseNow
      } as any);
      manager.onProviderError({
        code: 'HTTP_500',
        status: 500,
        message: 'upstream failure',
        runtime: { providerKey, runtimeKey: 'quota.key1' },
        timestamp: baseNow + 10_000
      } as any);
      manager.onProviderError({
        code: 'HTTP_500',
        status: 500,
        message: 'upstream failure',
        runtime: { providerKey, runtimeKey: 'quota.key1' },
        timestamp: baseNow + 20_000
      } as any);

      expect(manager.getSnapshot().providers[providerKey]?.reason).toBe('cooldown');

      manager.onProviderSuccess({
        runtime: { providerKey, runtimeKey: 'quota.key1' },
        timestamp: baseNow + 20_001
      } as any);

      const snapshot = manager.getSnapshot().providers;
      await saveProviderQuotaSnapshot(snapshot as any, new Date(baseNow + 20_002));
      const loaded = await loadProviderQuotaSnapshot();
      const reloaded = loaded?.providers[providerKey];

      expect(reloaded).toBeDefined();
      expect(reloaded?.inPool).toBe(true);
      expect(reloaded?.reason).toBe('ok');
      expect(reloaded?.cooldownUntil).toBeNull();
      expect(reloaded?.blacklistUntil).toBeNull();
      expect(reloaded?.lastErrorAtMs).toBeNull();
      expect(reloaded?.consecutiveErrorCount).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (originalQuotaDir === undefined) delete process.env.ROUTECODEX_QUOTA_DIR;
      else process.env.ROUTECODEX_QUOTA_DIR = originalQuotaDir;
    }
  });
});
