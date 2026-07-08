import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';

function buildRouteMetadata(requestId: string): any {
  return {
    requestId,
    metadataCenterSnapshot: {}
  };
}

function tripProviderThroughRecoverableError(engine: VirtualRouterEngine, providerKey: string): void {
  for (let index = 1; index <= 3; index += 1) {
    engine.handleProviderError({
      code: 'HTTP_500',
      message: `upstream internal error #${index}`,
      stage: 'provider.send',
      status: 500,
      runtime: {
        requestId: `req-recoverable-${providerKey}-${index}`,
        routeName: 'default',
        providerKey,
        runtimeKey: providerKey
      },
      timestamp: Date.now(),
      details: {
        errorClassification: 'recoverable'
      }
    } as any);
  }
}

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
    tripProviderThroughRecoverableError(engine, providerKey);

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      buildRouteMetadata('req-native-default-floor')
    );

    expect(result.target.providerKey).toBe(providerKey);
    expect(result.decision.routeName).toBe('default');
  });

  it('keeps default route non-empty even when every candidate is manually marked health.cooldown', () => {
    const providerA = 'deepseek.key1.deepseek-v4-pro';
    const providerB = 'deepseek.key2.deepseek-v4-pro';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig([providerA, providerB]));
    tripProviderThroughRecoverableError(engine, providerA);
    tripProviderThroughRecoverableError(engine, providerB);

    const status = engine.getStatus();
    const healthA = status.health.find((entry: any) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    const healthB = status.health.find((entry: any) => entry.providerKey === providerB || entry.providerKey === providerB.replace('.key2.', '.2.'));
    expect(healthA?.state).toBe('tripped');
    expect(healthB?.state).toBe('tripped');

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      buildRouteMetadata('req-native-cooldown')
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
      buildRouteMetadata('req-native-concurrency-runtime-key')
    );
    expect(result.target.providerKey).toBe(providerKey);
    expect(result.decision.routeName).toBe('default');
  });

  it('keeps the last default-pool provider selectable when provider errors explicitly do not affect health', () => {
    const providerKey = 'recoverable.key1.gpt-test';
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
          providerType: 'openai',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'recoverable.key1',
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
    } as any);

    for (let index = 1; index <= 3; index += 1) {
      engine.handleProviderError({
        code: 'HTTP_500',
        message: `upstream internal error #${index}`,
        stage: 'provider.send',
        status: 500,
        runtime: {
          requestId: `req-recoverable-${index}`,
          routeName: 'default',
          providerKey,
          runtimeKey: 'recoverable.key1'
        },
        timestamp: Date.now(),
        details: {
          errorClassification: 'recoverable',
          routePoolSize: 1
        },
        affectsHealth: false
      } as any);
    }

    const status = engine.getStatus();
    const healthEntry = status.health?.find((entry: any) =>
      entry.providerKey === providerKey || entry.providerKey === providerKey.replace('.key1.', '.1.')
    );
    expect(healthEntry?.state).toBe('healthy');
    expect(healthEntry?.failureCount).toBe(0);

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      buildRouteMetadata('req-last-default-after-recoverable-three-strikes')
    );

    expect(result.target.providerKey).toBe(providerKey);
    expect(result.decision.routeName).toBe('default');
  });

  it('keeps selecting the priority provider when provider errors explicitly do not affect health', () => {
    const providerA = 'recoverable.key1.gpt-test';
    const providerB = 'recoverable.key2.gpt-test';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig([providerA, providerB]));

    for (let index = 1; index <= 3; index += 1) {
      engine.handleProviderError({
        code: 'HTTP_500',
        message: `upstream internal error #${index}`,
        stage: 'provider.send',
        status: 500,
        runtime: {
          requestId: `req-recoverable-alt-${index}`,
          routeName: 'default',
          providerKey: providerA,
          runtimeKey: 'deepseek.key1'
        },
        timestamp: Date.now(),
        details: {
          errorClassification: 'recoverable',
          routePoolSize: 2
        },
        affectsHealth: false
      } as any);
    }

    const result = engine.route(
      {
        messages: [{ role: 'user', content: 'hello' }]
      } as any,
      buildRouteMetadata('req-recoverable-alt-failure')
    );

    expect(result.target.providerKey).toBe(providerA);
    expect(result.decision.routeName).toBe('default');
  });
});
