import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

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

describe('virtual router last-provider quotaView bridge-only baseline', () => {
  test('single-provider route is no longer emptied by TS quotaView when Rust has no blocker', () => {
    const providerKey = `quota.lastprovider.${Date.now()}.gpt-test`;
    const cooldownUntil = Date.now() + 5_000;
    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(buildSingleProviderConfig(providerKey));
    const engine = new VirtualRouterEngine({
      quotaView: () => ({
        providerKey,
        inPool: false,
        reason: 'quotaDepleted',
        cooldownUntil,
        cooldownKeepsPool: false,
        priorityTier: 100
      } as any)
    } as any);
    engine.initialize(buildSingleProviderConfig(providerKey));

    const rustOnlyDecision = rustOnly.route(
      { messages: [{ role: 'user', content: 'hello' }] } as any,
      { requestId: 'req-last-provider-quota-view-rust' } as any
    );
    const decision = engine.route(
      { messages: [{ role: 'user', content: 'hello' }] } as any,
      { requestId: 'req-last-provider-quota-view' } as any
    );

    expect(rustOnlyDecision.target.providerKey).toBe(providerKey);
    expect(decision.target.providerKey).toBe(providerKey);
  });
});
