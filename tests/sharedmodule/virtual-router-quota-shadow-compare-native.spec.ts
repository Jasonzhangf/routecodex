import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildRouteMetadata(requestId: string): any {
  return {
    requestId,
    metadataCenterSnapshot: {}
  };
}

function buildDualProviderConfig(providerA = 'quota.key1.gpt-test', providerB = 'quota.key2.gpt-test'): any {
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
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function buildSingleProviderConfig(providerKey = 'quota.key1.gpt-test'): any {
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
          targets: [providerKey]
        }
      ]
    },
    providers: {
      [providerKey]: {
        providerKey,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'quota.key1',
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

describe('virtual router quota shadow compare against TS second center', () => {
  test('same-shape route decision stays identical even if TS quotaView marks primary key out-of-pool', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const request = { messages: [{ role: 'user', content: 'hello' }] } as any;
    const metadata = buildRouteMetadata('req-quota-shadow-compare-route');

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) => {
      if (providerKey === providerA) {
        return {
          providerKey,
          inPool: false,
          reason: 'quotaDepleted',
          cooldownUntil: Date.now() + 60_000,
          blacklistUntil: null,
          priorityTier: 100
        };
      }
      return {
        providerKey,
        inPool: true,
        priorityTier: 100
      };
    });

    const rustOnlyDecision = rustOnly.route(request, metadata);
    const tsPoisonedDecision = tsPoisoned.route(request, metadata);

    expect([providerA, providerB]).toContain(rustOnlyDecision.target.providerKey);
    expect(tsPoisonedDecision.target.providerKey).toBe(rustOnlyDecision.target.providerKey);
    expect(tsPoisonedDecision.decision.routeName).toBe(rustOnlyDecision.decision.routeName);
  });

  test('singleton route still selects the only provider even if TS quotaView advertises an out-of-pool cooldown', () => {
    const providerKey = 'quota.key1.gpt-test';
    const config = buildSingleProviderConfig(providerKey);
    const request = { messages: [{ role: 'user', content: 'hello' }] } as any;
    const metadata = buildRouteMetadata('req-quota-shadow-compare-singleton');
    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (key) => ({
      providerKey: key,
      inPool: false,
      reason: 'quotaDepleted',
      cooldownUntil: Date.now() + 60_000,
      priorityTier: 100,
    }));

    const rustOnlyDecision = rustOnly.route(request, metadata);
    const tsPoisonedDecision = tsPoisoned.route(request, metadata);

    expect(rustOnlyDecision.target.providerKey).toBe(providerKey);
    expect(tsPoisonedDecision.target.providerKey).toBe(providerKey);
    expect(tsPoisonedDecision.decision.routeName).toBe('default');
  });
});
