import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

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
  it('keeps the last default-pool provider selectable instead of returning empty pool', () => {
    const providerKey = 'deepseek.key1.deepseek-v4-pro';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig([providerKey]));
    engine.markProviderCooldown(providerKey, 1500);

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-native-default-floor' } as any
    );

    expect(result.target.providerKey).toBe(providerKey);
    expect(result.decision.routeName).toBe('default');
  });

  it('keeps default route non-empty even when every candidate is manually marked health.cooldown', () => {
    const providerA = 'deepseek.key1.deepseek-v4-pro';
    const providerB = 'deepseek.key2.deepseek-v4-pro';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig([providerA, providerB]));
    engine.markProviderCooldown(providerA, 1500);
    engine.markProviderCooldown(providerB, 2500);

    const status = engine.getStatus();
    const healthA = status.health.find((entry: any) => entry.providerKey === providerA.replace('.key1.', '.1.'));
    const healthB = status.health.find((entry: any) => entry.providerKey === providerB.replace('.key2.', '.2.'));
    expect(healthA?.state).toBe('tripped');
    expect(healthB?.state).toBe('tripped');

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-native-cooldown' } as any
    );
    expect([providerA, providerB]).toContain(result.target.providerKey);
    expect(result.decision.routeName).toBe('default');
  });

  it('keeps default route non-empty when concurrency.busy is keyed by runtimeKey instead of providerKey', () => {
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

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      { requestId: 'req-native-concurrency-runtime-key' } as any
    );
    expect(result.target.providerKey).toBe(providerKey);
    expect(result.decision.routeName).toBe('default');
  });
});
