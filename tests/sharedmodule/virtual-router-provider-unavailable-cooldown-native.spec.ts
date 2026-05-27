import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildConfig(providerKeys = ['deepseek.key1.deepseek-v4-pro']): any {
  const providers = Object.fromEntries(
    providerKeys.map((providerKey, index) => [
      providerKey,
      {
        providerKey,
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: `deepseek.key${index + 1}`,
        modelId: 'deepseek-v4-pro'
      }
    ])
  );
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
          targets: providerKeys
        }
      ]
    },
    providers,
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
  it('preserves recoverable health.cooldown hints on native PROVIDER_NOT_AVAILABLE when every candidate is cooling down', () => {
    const providerA = 'deepseek.key1.deepseek-v4-pro';
    const providerB = 'deepseek.key2.deepseek-v4-pro';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig([providerA, providerB]));
    engine.markProviderCooldown(providerA, 1500);
    engine.markProviderCooldown(providerB, 2500);

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
      expect(err.details?.candidateProviderCount).toBe(2);
      const hints = err.details?.recoverableCooldownHints as Array<Record<string, unknown>>;
      expect(hints[0]).toMatchObject({
        providerKey: providerA,
        source: 'health.cooldown'
      });
      expect(hints.some((item) => item.providerKey === providerB && item.source === 'health.cooldown')).toBe(true);
    }
  });

  it('surfaces concurrency.busy cooldown when busy state is keyed by runtimeKey instead of providerKey', () => {
    const providerKey = 'dbittai.key1.MiniMax-M2.7';
    const runtimeKey = 'dbittai.key1';
    const engine = new VirtualRouterEngine();
    engine.initialize({
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
          providerType: 'anthropic',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'anthropic-messages',
          runtimeKey,
          modelId: 'MiniMax-M2.7'
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'round-robin' },
      health: {
        failureThreshold: 3,
        cooldownMs: 30_000,
        fatalCooldownMs: 120_000
      }
    } as any);
    engine.markConcurrencyScopeBusy(runtimeKey);

    try {
      engine.route(
        {
          messages: [{ role: 'user', content: 'hello' }]
        } as any,
        { requestId: 'req-native-concurrency-runtime-key' } as any
      );
      throw new Error('expected route to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VirtualRouterError);
      const err = error as VirtualRouterError & { details?: Record<string, unknown> };
      expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
      expect(typeof err.details?.minRecoverableCooldownMs).toBe('number');
      expect((err.details?.minRecoverableCooldownMs as number) > 0).toBe(true);
      expect(Array.isArray(err.details?.recoverableCooldownHints)).toBe(true);
      expect((err.details?.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
        providerKey,
        source: 'concurrency.busy'
      });
    }
  });
});
