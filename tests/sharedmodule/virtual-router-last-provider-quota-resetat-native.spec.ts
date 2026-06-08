import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';

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
  test('single-provider QUOTA_DEPLETED should degrade to short recoverable cooldown instead of full resetAt lockout', () => {
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

    try {
      engine.route(
        { messages: [{ role: 'user', content: 'hello' }] } as any,
        { requestId: 'req-singleton-quota-resetat' } as any
      );
      throw new Error('expected route to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VirtualRouterError);
      const err = error as VirtualRouterError & { details?: Record<string, unknown> };
      expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
      expect(typeof err.details?.minRecoverableCooldownMs).toBe('number');
      const waitMs = err.details?.minRecoverableCooldownMs as number;
      expect(waitMs).toBeGreaterThan(0);
      expect(waitMs).toBeLessThanOrEqual(10_000);
      expect(Array.isArray(err.details?.recoverableCooldownHints)).toBe(true);
      expect((err.details?.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
        providerKey,
        source: 'rust.quota'
      });
    }
  });
});
