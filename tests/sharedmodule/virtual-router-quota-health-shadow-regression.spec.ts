import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildDualProviderConfig(providerA = 'shadowgate.key1.gpt-test', providerB = 'shadowgate.key2.gpt-test'): any {
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
          targets: [providerA, providerB]
        }
      ]
    },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'shadowgate.key1',
        modelId: 'gpt-test'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'shadowgate.key2',
        modelId: 'gpt-test'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function createEngineWithPoisonedQuotaView(config: any, poison: (providerKey: string) => Record<string, unknown> | null): VirtualRouterEngine {
  const engine = new VirtualRouterEngine({
    quotaView: (providerKey: string) => poison(providerKey)
  } as any);
  engine.initialize(config);
  return engine;
}

function routeProviderKey(engine: VirtualRouterEngine, requestId: string): string {
  return engine.route(
    { messages: [{ role: 'user', content: 'hello' }] } as any,
    { requestId, metadataCenterSnapshot: {} } as any
  ).target.providerKey;
}

describe('virtual router health shadow regression gate', () => {
  test('poisoned TS quotaView cannot override Rust route decision for healthy dual-provider pool', () => {
    const providerA = 'shadowgate.key1.gpt-test';
    const providerB = 'shadowgate.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) =>
      providerKey === providerA
        ? {
            providerKey,
            inPool: false,
            reason: 'quotaDepleted',
            cooldownUntil: Date.now() + 60_000,
            priorityTier: 100
          }
        : { providerKey, inPool: true, priorityTier: 100 }
    );

    const rustOnlyDecision = routeProviderKey(rustOnly, 'req-shadow-healthy-rust');
    const poisonedDecision = routeProviderKey(tsPoisoned, 'req-shadow-healthy-poisoned');
    expect([providerA, providerB]).toContain(rustOnlyDecision);
    expect(poisonedDecision).toBe(rustOnlyDecision);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-healthy-poisoned-repeat')).toBe(
      routeProviderKey(rustOnly, 'req-shadow-healthy-rust-repeat')
    );
  });

  test('health cooldown remains Rust-owned even when TS quotaView lies about pool state', () => {
    const providerA = 'shadowgate.key1.gpt-test';
    const providerB = 'shadowgate.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const healthError = {
      code: 'HTTP_503',
      message: 'provider unavailable',
      status: 503,
      runtime: {
        requestId: 'req-shadow-health-resetat-source',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'shadowgate.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(healthError);
    rustOnly.handleProviderError(healthError);
    rustOnly.handleProviderError(healthError);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, () => ({
      providerKey: providerA,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(healthError);
    tsPoisoned.handleProviderError(healthError);
    tsPoisoned.handleProviderError(healthError);

    expect(routeProviderKey(rustOnly, 'req-shadow-health-rust')).toBe(providerB);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-health-poisoned')).toBe(providerB);

    const rustStatus = rustOnly.getStatus();
    const healthA = rustStatus.health?.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    const healthB = rustStatus.health?.find((entry) => entry.providerKey === providerB || entry.providerKey === providerB.replace('.key2.', '.2.'));
    expect(healthA?.state).toBe('tripped');
    expect(typeof healthA?.cooldownExpiresAt).toBe('number');
    expect(healthB?.state).toBe('healthy');
  });

  test('auth fatal health blocker remains Rust-owned even when TS quotaView pretends provider is still in pool', () => {
    const providerA = 'shadowgate.key1.gpt-test';
    const providerB = 'shadowgate.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const fatalEvent = {
      code: 'INVALID_API_KEY',
      message: 'invalid auth',
      stage: 'provider.send',
      status: 401,
      errorClassification: 'unrecoverable',
      runtime: {
        requestId: 'req-shadow-auth-fatal',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'shadowgate.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(fatalEvent);
    rustOnly.handleProviderError(fatalEvent);
    rustOnly.handleProviderError(fatalEvent);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) => ({
      providerKey,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(fatalEvent);
    tsPoisoned.handleProviderError(fatalEvent);
    tsPoisoned.handleProviderError(fatalEvent);

    expect(routeProviderKey(rustOnly, 'req-shadow-auth-fatal-rust')).toBe(providerB);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-auth-fatal-poisoned')).toBe(providerB);

    const rustHealth = rustOnly.getStatus().health.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    expect(rustHealth?.state).toBe('tripped');
    expect((rustHealth?.failureCount ?? 0) >= 3).toBe(true);
  });

  test('recoverable transport cooldown stays Rust-owned and success clears it without reopening TS second center', () => {
    const providerA = 'shadowgate.key1.gpt-test';
    const providerB = 'shadowgate.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const transportEvent = {
      code: 'HTTP_503',
      message: 'transport unavailable',
      stage: 'provider.send',
      status: 503,
      errorClassification: 'recoverable',
      runtime: {
        requestId: 'req-shadow-transport-cooldown',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'shadowgate.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;
    const successEvent = {
      runtime: {
        requestId: 'req-shadow-transport-recover',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'shadowgate.key1'
      },
      timestamp: Date.now()
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(transportEvent);
    rustOnly.handleProviderError(transportEvent);
    rustOnly.handleProviderError(transportEvent);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) => ({
      providerKey,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(transportEvent);
    tsPoisoned.handleProviderError(transportEvent);
    tsPoisoned.handleProviderError(transportEvent);

    expect(routeProviderKey(rustOnly, 'req-shadow-transport-rust-reroute')).toBe(providerB);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-transport-poisoned-reroute')).toBe(providerB);

    rustOnly.handleProviderSuccess(successEvent);
    tsPoisoned.handleProviderSuccess(successEvent);

    expect(routeProviderKey(rustOnly, 'req-shadow-transport-rust-recovered')).toBe(providerA);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-transport-poisoned-recovered')).toBe(providerA);
  });


  test('503 daily unavailable health cooldown remains Rust-owned even when TS quotaView advertises provider as active', () => {
    const providerA = 'shadowgate.key1.gpt-test';
    const providerB = 'shadowgate.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const daily503Event = {
      code: 'HTTP_503',
      message: 'provider unavailable',
      stage: 'provider.send',
      status: 503,
      errorClassification: 'recoverable',
      runtime: {
        requestId: 'req-shadow-503-daily',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'shadowgate.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(daily503Event);
    rustOnly.handleProviderError(daily503Event);
    rustOnly.handleProviderError(daily503Event);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) => ({
      providerKey,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(daily503Event);
    tsPoisoned.handleProviderError(daily503Event);
    tsPoisoned.handleProviderError(daily503Event);

    expect(routeProviderKey(rustOnly, 'req-shadow-503-rust')).toBe(providerB);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-503-poisoned')).toBe(providerB);

    const rustHealth = rustOnly.getStatus().health.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    expect(rustHealth?.state).toBe('tripped');
    expect(typeof rustHealth?.cooldownExpiresAt).toBe('number');
  });
});
