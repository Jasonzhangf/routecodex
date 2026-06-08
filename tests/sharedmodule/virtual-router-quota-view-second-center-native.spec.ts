import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

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

describe('virtual router native quotaView bridge-only baseline', () => {
  test('TS quotaView out-of-pool state no longer overrides route decision when Rust has no blocker', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(buildDualProviderConfig(providerA, providerB));
    const engine = new VirtualRouterEngine({
      quotaView: (providerKey: string) => {
        if (providerKey === providerA) {
          return {
            providerKey,
            inPool: false,
            reason: 'quotaDepleted',
            cooldownUntil: Date.now() + 60_000,
            cooldownKeepsPool: false,
            priorityTier: 100
          } as any;
        }
        return {
          providerKey,
          inPool: true,
          priorityTier: 100
        } as any;
      }
    } as any);
    engine.initialize(buildDualProviderConfig(providerA, providerB));

    const rustOnlyDecision = rustOnly.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-quota-view-second-center' } as any
    );
    const decision = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-quota-view-second-center' } as any
    );

    expect([providerA, providerB]).toContain(rustOnlyDecision.target.providerKey);
    expect(decision.target.providerKey).toBe(rustOnlyDecision.target.providerKey);
  });
});
