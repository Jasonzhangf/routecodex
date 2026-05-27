import { describe, expect, test } from '@jest/globals';

import { QuotaManager } from '../../sharedmodule/llmswitch-core/src/quota/index.js';

describe('sharedmodule core QuotaManager success recovery', () => {
  test('success clears active quota cooldown and restores provider to ok/inPool', () => {
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

    const before = manager.getSnapshot().providers[providerKey];
    expect(before).toBeDefined();
    expect(before.reason).toBe('cooldown');
    expect(before.inPool).toBe(true);
    expect(typeof before.cooldownUntil).toBe('number');
    expect((before.cooldownUntil as number) > baseNow + 20_000).toBe(true);

    manager.onProviderSuccess({
      runtime: { providerKey, runtimeKey: 'quota.key1' },
      timestamp: baseNow + 20_001
    } as any);

    const after = manager.getSnapshot().providers[providerKey];
    expect(after).toBeDefined();
    expect(after.inPool).toBe(true);
    expect(after.reason).toBe('ok');
    expect(after.cooldownUntil).toBeNull();
    expect(after.blacklistUntil).toBeNull();
    expect(after.lastErrorAtMs).toBeNull();
    expect(after.consecutiveErrorCount).toBe(0);

    const quotaView = manager.getQuotaView()(providerKey);
    expect(quotaView).toMatchObject({
      providerKey,
      inPool: true,
      reason: 'ok',
      consecutiveErrorCount: 0
    });
    expect(quotaView?.cooldownUntil).toBeNull();
  });
});
