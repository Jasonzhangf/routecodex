import { jest } from '@jest/globals';

describe('provider-quota-daemon weekly windsurf quota', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('blacklists windsurf weekly quota exhausted key for 24h instead of keep-pool cooldown', async () => {
    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');
    const { createInitialQuotaState } = await import('../../../../src/manager/quota/provider-quota-center.js');
    const { ProviderModelBackoffTracker } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.model-backoff.js');

    const nowMs = 1_700_000_000_000;
    const providerKey = 'windsurf.ws-pro-1.gpt-5.4-medium';
    const quotaStates = new Map<string, any>();
    quotaStates.set(providerKey, createInitialQuotaState(providerKey, { authType: 'apikey' }, nowMs));

    const ctx = {
      quotaStates,
      staticConfigs: new Map<string, any>(),
      quotaRoutingEnabled: true,
      modelBackoff: new ProviderModelBackoffTracker(),
      schedulePersist: jest.fn(),
      toSnapshotObject: () => Object.fromEntries(quotaStates.entries())
    };

    await handleProviderQuotaErrorEvent(ctx as any, {
      code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
      message: 'Your weekly usage quota has been exhausted.',
      stage: 'provider.send',
      status: 429,
      recoverable: false,
      affectsHealth: true,
      timestamp: nowMs,
      runtime: {
        requestId: 'req-ws-weekly',
        providerKey,
        providerId: 'windsurf',
        providerType: 'openai',
        routeName: 'thinking'
      },
      details: {
        errorClassification: 'unrecoverable',
        routePoolSize: 3,
        rateLimitKind: 'daily_limit',
        cooldownOverrideMs: 24 * 60 * 60_000,
        quotaScope: 'weekly',
        quotaReason: 'windsurf_weekly_exhausted'
      }
    } as any);

    const state = quotaStates.get(providerKey);
    expect(state).toBeDefined();
    expect(state.inPool).toBe(false);
    expect(state.cooldownKeepsPool).not.toBe(true);
    expect(state.reason).toBe('blacklist');
    expect(state.cooldownUntil).toBeNull();
    expect(state.blacklistUntil).toBe(nowMs + 24 * 60 * 60_000);
  });
});
