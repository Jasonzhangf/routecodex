import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildConfig(providerKey = 'deepseek.key1.deepseek-v4-pro'): any {
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
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'deepseek.key1',
        modelId: 'deepseek-v4-pro'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'round-robin' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

describe('virtual router native provider unavailable cooldown details', () => {
  it('preserves recoverable cooldown hints on native PROVIDER_NOT_AVAILABLE', () => {
    const providerKey = 'deepseek.key1.deepseek-v4-pro';
    const cooldownUntil = Date.now() + 1500;
    const engine = new VirtualRouterEngine({
      quotaView: () => ({
        inPool: false,
        cooldownUntil,
        blacklistUntil: null
      })
    } as any);
    engine.initialize(buildConfig(providerKey));

    try {
      engine.route(
        {
          messages: [{ role: 'user', content: 'hello' }]
        } as any,
        { requestId: 'req-native-cooldown' } as any
      );
      throw new Error('expected route to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VirtualRouterError);
      const err = error as VirtualRouterError & { details?: Record<string, unknown> };
      expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
      expect(typeof err.details?.minRecoverableCooldownMs).toBe('number');
      expect((err.details?.minRecoverableCooldownMs as number) > 0).toBe(true);
      expect((err.details?.minRecoverableCooldownMs as number) <= 1500).toBe(true);
      expect(Array.isArray(err.details?.recoverableCooldownHints)).toBe(true);
      expect((err.details?.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
        providerKey,
        source: 'quota.cooldown'
      });
    }
  });
});
