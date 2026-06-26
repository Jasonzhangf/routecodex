import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildRouteMetadata(requestId: string): any {
  return {
    requestId,
    metadataCenterSnapshot: {}
  };
}
const FUTURE_RESET_AT = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

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

describe('virtual router singleton quota resetAt rust guard', () => {
  test('single-provider QUOTA_DEPLETED no longer removes the last provider from routing availability', () => {
    const providerKey = 'quota.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildSingleProviderConfig(providerKey));

    engine.handleProviderError({
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: FUTURE_RESET_AT,
      runtime: {
        requestId: 'req-singleton-quota-resetat',
        routeName: 'default',
        providerKey,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any);

    const decision = engine.route(
      { messages: [{ role: 'user', content: 'hello' }] } as any,
      buildRouteMetadata('req-singleton-quota-resetat')
    );

    expect(decision.target.providerKey).toBe(providerKey);
    expect(decision.decision.routeName).toBe('default');
  });
});
