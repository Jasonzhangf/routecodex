import { describe, expect, it, jest } from '@jest/globals';

describe('provider-quota-daemon iFlow 434 handling', () => {
  it('blacklists provider when iFlow AK is blocked (434)', async () => {
    jest.resetModules();

    const appendProviderErrorEvent = jest.fn(async () => {});
    const saveProviderQuotaSnapshot = jest.fn(async () => {});

    jest.unstable_mockModule('../../../../src/manager/quota/provider-quota-store.js', () => ({
      appendProviderErrorEvent,
      saveProviderQuotaSnapshot
    }));

    const prevBlacklistMs = process.env.ROUTECODEX_IFLOW_434_BLACKLIST_MS;
    process.env.ROUTECODEX_IFLOW_434_BLACKLIST_MS = '60000';

    try {
      const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');

      const providerKey = 'iflow.3-138.kimi-k2.5';
      const quotaStates = new Map<string, any>();
      const staticConfigs = new Map<string, any>();
      staticConfigs.set(providerKey, { authType: 'oauth', priorityTier: 100 });

      const ctx: any = {
        quotaStates,
        staticConfigs,
        quotaRoutingEnabled: true,
        modelBackoff: {
          recordCapacity429: () => {},
          getActiveCooldownUntil: () => null
        },
        schedulePersist: () => {},
        toSnapshotObject: () => Object.fromEntries(quotaStates)
      };

      const event: any = {
        status: 400,
        code: 'HTTP_400',
        stage: 'provider.provider.http',
        message: 'HTTP 400: iFlow business error (434): Access to the current AK has been blocked due to unauthorized requests',
        details: {
          upstreamCode: '434',
          upstreamMessage: 'Access to the current AK has been blocked due to unauthorized requests'
        },
        runtime: {
          providerKey,
          target: { providerKey }
        }
      };

      const startedAt = Date.now();
      await handleProviderQuotaErrorEvent(ctx, event);
      const next = quotaStates.get(providerKey);

      expect(next).toBeDefined();
      expect(next?.inPool).toBe(false);
      expect(next?.reason).toBe('blacklist');
      expect(typeof next?.blacklistUntil).toBe('number');
      expect(next?.blacklistUntil).toBeGreaterThanOrEqual(startedAt + 60_000 - 1000);
      expect(next?.lastErrorSeries).toBe('EFATAL');
      expect(next?.lastErrorCode).toBe('IFLOW_434');
      expect(appendProviderErrorEvent).toHaveBeenCalledTimes(1);
    } finally {
      process.env.ROUTECODEX_IFLOW_434_BLACKLIST_MS = prevBlacklistMs;
    }
  });
});
