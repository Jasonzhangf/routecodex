import { jest } from '@jest/globals';

describe('provider-quota-daemon weekly windsurf quota', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('blacklists windsurf weekly quota exhausted key until next local 00:00 when upstream omits cooldown override', async () => {
    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');
    const { createInitialQuotaState } = await import('../../../../src/manager/quota/provider-quota-center.js');
    const { ProviderModelBackoffTracker } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.model-backoff.js');

    const nowMs = new Date('2026-05-23T10:30:00+08:00').getTime();
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
    expect(state.blacklistUntil).toBe(new Date('2026-05-24T00:00:00+08:00').getTime());
  });


  it('RED: keeps model-scoped windsurf resource_exhausted as cooldown instead of weekly alias blacklist', async () => {
    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');
    const { createInitialQuotaState } = await import('../../../../src/manager/quota/provider-quota-center.js');
    const { ProviderModelBackoffTracker } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.model-backoff.js');

    const nowMs = new Date('2026-05-23T10:30:00+08:00').getTime();
    const hitKey = 'windsurf.ws-pro-4.gpt-5.4-medium';
    const siblingKey = 'windsurf.ws-pro-4.gpt-5.4-high';
    const aliasKey = 'windsurf.ws-pro-4';
    const quotaStates = new Map<string, any>();
    for (const key of [hitKey, siblingKey, aliasKey]) {
      quotaStates.set(key, createInitialQuotaState(key, { authType: 'apikey' }, nowMs));
    }

    const staticConfigs = new Map<string, any>();
    staticConfigs.set(hitKey, { authType: 'apikey' });
    staticConfigs.set(siblingKey, { authType: 'apikey' });
    staticConfigs.set(aliasKey, { authType: 'apikey' });

    const ctx = {
      quotaStates,
      staticConfigs,
      quotaRoutingEnabled: true,
      modelBackoff: new ProviderModelBackoffTracker(),
      schedulePersist: jest.fn(),
      toSnapshotObject: () => Object.fromEntries(quotaStates.entries())
    };

    await handleProviderQuotaErrorEvent(ctx as any, {
      code: 'WINDSURF_RATE_LIMITED',
      message: 'resource_exhausted: model message limit hit',
      stage: 'provider.send',
      status: 429,
      recoverable: false,
      affectsHealth: true,
      timestamp: nowMs,
      runtime: {
        requestId: 'req-ws-model-limit',
        providerKey: hitKey,
        providerId: 'windsurf',
        providerType: 'openai',
        routeName: 'thinking'
      },
      details: {
        rateLimitKind: 'daily_limit',
        cooldownOverrideMs: 24 * 60 * 60_000,
        quotaScope: 'model',
        quotaReason: 'windsurf_model_rate_limited'
      }
    } as any);

    const hitState = quotaStates.get(hitKey);
    const siblingState = quotaStates.get(siblingKey);
    const aliasState = quotaStates.get(aliasKey);
    expect(hitState.reason).toBe('cooldown');
    expect(hitState.inPool).toBe(true);
    expect(typeof hitState.cooldownUntil).toBe('number');
    expect(hitState.cooldownUntil).toBeGreaterThan(nowMs);
    expect(hitState.cooldownUntil).toBeLessThanOrEqual(nowMs + 24 * 60 * 60_000);
    expect(hitState.blacklistUntil).toBeNull();
    expect(siblingState.reason).toBe('ok');
    expect(aliasState.reason).toBe('ok');
  });

  it('blacklists entire windsurf account alias family until next local 00:00 when one model hits weekly exhausted', async () => {
    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');
    const { createInitialQuotaState } = await import('../../../../src/manager/quota/provider-quota-center.js');
    const { ProviderModelBackoffTracker } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.model-backoff.js');

    const nowMs = new Date('2026-05-23T10:30:00+08:00').getTime();
    const hitKey = 'windsurf.ws-pro-1.gpt-5.4-medium';
    const siblingKey = 'windsurf.ws-pro-1.gpt-5.3-codex-low';
    const otherAliasKey = 'windsurf.ws-pro-2.gpt-5.4-medium';
    const rootAliasKey = 'windsurf.ws-pro-1';
    const quotaStates = new Map<string, any>();
    for (const key of [hitKey, siblingKey, otherAliasKey, rootAliasKey]) {
      quotaStates.set(key, createInitialQuotaState(key, { authType: 'apikey' }, nowMs));
    }

    const staticConfigs = new Map<string, any>();
    staticConfigs.set(hitKey, { authType: 'apikey' });
    staticConfigs.set(siblingKey, { authType: 'apikey' });
    staticConfigs.set(otherAliasKey, { authType: 'apikey' });
    staticConfigs.set(rootAliasKey, { authType: 'apikey' });

    const ctx = {
      quotaStates,
      staticConfigs,
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
        requestId: 'req-ws-weekly-family',
        providerKey: hitKey,
        providerId: 'windsurf',
        providerType: 'openai',
        routeName: 'thinking'
      },
      details: {
        quotaScope: 'weekly',
        quotaReason: 'windsurf_weekly_exhausted'
      }
    } as any);

    const hitState = quotaStates.get(hitKey);
    const siblingState = quotaStates.get(siblingKey);
    const rootAliasState = quotaStates.get(rootAliasKey);
    const otherAliasState = quotaStates.get(otherAliasKey);
    expect(hitState.reason).toBe('blacklist');
    expect(siblingState.reason).toBe('blacklist');
    expect(rootAliasState.reason).toBe('blacklist');
    expect(otherAliasState.reason).toBe('ok');
    const nextMidnight = new Date('2026-05-24T00:00:00+08:00').getTime();
    expect(siblingState.blacklistUntil).toBe(nextMidnight);
    expect(rootAliasState.blacklistUntil).toBe(nextMidnight);
  });

  it('RED: detects windsurf IP-level rate-limit burst after 3 same-model 429s and cools down sibling accounts too', async () => {
    const { handleProviderQuotaErrorEvent } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.events.js');
    const { createInitialQuotaState } = await import('../../../../src/manager/quota/provider-quota-center.js');
    const { ProviderModelBackoffTracker } = await import('../../../../src/manager/modules/quota/provider-quota-daemon.model-backoff.js');

    const baseNow = 1_700_000_000_000;
    const keys = [
      'windsurf.ws-pro-a.gpt-5.4-medium',
      'windsurf.ws-pro-b.gpt-5.4-medium',
      'windsurf.ws-pro-c.gpt-5.4-medium',
      'windsurf.ws-pro-d.gpt-5.4-medium',
    ];
    const quotaStates = new Map<string, any>();
    const staticConfigs = new Map<string, any>();
    for (const key of keys) {
      quotaStates.set(key, createInitialQuotaState(key, { authType: 'apikey' }, baseNow));
      staticConfigs.set(key, { authType: 'apikey' });
    }

    const ctx = {
      quotaStates,
      staticConfigs,
      quotaRoutingEnabled: true,
      modelBackoff: new ProviderModelBackoffTracker(),
      schedulePersist: jest.fn(),
      toSnapshotObject: () => Object.fromEntries(quotaStates.entries())
    };

    const emit429 = async (providerKey: string, nowMs: number) => {
      await handleProviderQuotaErrorEvent(ctx as any, {
        code: 'WINDSURF_RATE_LIMITED',
        message: 'resource_exhausted: reached your message limit for this model',
        stage: 'provider.send',
        status: 429,
        recoverable: false,
        affectsHealth: true,
        timestamp: nowMs,
        runtime: {
          requestId: `req-${providerKey}-${nowMs}`,
          providerKey,
          providerId: 'windsurf',
          providerType: 'openai',
          routeName: 'thinking'
        },
        details: {
          rateLimitKind: 'short_lived',
          quotaScope: 'model',
          quotaReason: 'windsurf_model_rate_limited'
        }
      } as any);
    };

    await emit429(keys[0]!, baseNow);
    await emit429(keys[1]!, baseNow + 1000);
    await emit429(keys[2]!, baseNow + 2000);

    const hit1 = quotaStates.get(keys[0]!);
    const hit2 = quotaStates.get(keys[1]!);
    const hit3 = quotaStates.get(keys[2]!);
    const sibling = quotaStates.get(keys[3]!);

    expect(hit1.reason).toBe('cooldown');
    expect(hit2.reason).toBe('cooldown');
    expect(hit3.reason).toBe('cooldown');
    expect(typeof hit1.cooldownUntil).toBe('number');
    expect(typeof hit2.cooldownUntil).toBe('number');
    expect(typeof hit3.cooldownUntil).toBe('number');
    expect(hit1.cooldownUntil).toBeGreaterThanOrEqual(baseNow + 30_000);
    expect(hit2.cooldownUntil).toBeGreaterThanOrEqual(baseNow + 30_000);
    expect(hit3.cooldownUntil).toBeGreaterThanOrEqual(baseNow + 30_000);

    expect(sibling.reason).toBe('cooldown');
    expect(typeof sibling.cooldownUntil).toBe('number');
    expect(sibling.cooldownUntil).toBeGreaterThanOrEqual(baseNow + 2_000 + 30_000);
    expect(sibling.inPool).toBe(false);
  });
});
