import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

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

describe('virtual router native quota exhausted resetAt rust-state', () => {
  test('quota exhausted with resetAt freezes only current providerKey in Rust quota snapshot and reroutes to sibling key', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildDualProviderConfig(providerA, providerB));

    engine.handleProviderError({
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: '2026-05-28T00:00:00.000Z',
      runtime: {
        requestId: 'req-quota-resetat-native-gap',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any);

    const status = engine.getStatus();
    const providerAState = status.health.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    const providerBState = status.health.find((entry) => entry.providerKey === providerB || entry.providerKey === providerB.replace('.key2.', '.2.'));
    const providerAQuota = status.quota?.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    const providerBQuota = status.quota?.find((entry) => entry.providerKey === providerB || entry.providerKey === providerB.replace('.key2.', '.2.'));

    expect(providerAState).toBeDefined();
    expect(providerAState?.state).toBe('tripped');
    expect((providerAState?.failureCount ?? 0) > 0).toBe(true);
    expect(providerBState).toBeDefined();
    expect(providerBState?.state).toBe('healthy');
    expect(providerAQuota).toBeDefined();
    expect(providerAQuota?.inPool).toBe(false);
    expect(providerAQuota?.reason).toBe('quotaDepleted');
    expect(typeof providerAQuota?.resetAt).toBe('number');
    expect(providerBQuota).toBeDefined();
    expect(providerBQuota?.inPool).toBe(true);

    const decision = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-after-quota-resetat' } as any
    );

    expect(decision.target.providerKey).toBe(providerB);
  });
});
