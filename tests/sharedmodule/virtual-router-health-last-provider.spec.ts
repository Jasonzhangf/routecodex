import { describe, expect, it } from '@jest/globals';

import { VirtualRouterEngine } from './helpers/virtual-router-engine-direct-native.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';

function buildConfig(targets: string[]): any {
  const providers = Object.fromEntries(
    targets.map((providerKey, index) => [
      providerKey,
      {
        providerKey,
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: `runtime.${index + 1}`,
        modelId: 'gpt-test'
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
          targets
        }
      ]
    },
    providers,
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function routeOnce(engine: VirtualRouterEngine, requestId: string): string {
  return engine.route(
    { messages: [{ role: 'user', content: 'hello' }] } as any,
    { requestId, metadataCenterSnapshot: {} } as any
  ).target.providerKey;
}

describe('virtual router native last-provider guard', () => {
  it('does not cooldown the last remaining available provider for recoverable failures', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig(['provider.a']));

    engine.handleProviderFailure({
      providerKey: 'provider.a',
      reason: 'upstream_error',
      fatal: false,
      statusCode: 502,
      affectsHealth: false
    });

    expect(routeOnce(engine, 'req-last-provider-nonfatal')).toBe('provider.a');
    const state = engine.getStatus().health.find((entry: any) =>
      entry.providerKey === 'provider.a' || entry.providerKey === 'provider.1'
    );
    expect(state?.failureCount).toBe(0);
    expect(state?.state).toBe('healthy');
  });

  it('does not trip the last remaining available provider even on fatal events', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig(['provider.a', 'provider.b']));

    for (let index = 0; index < 3; index += 1) {
      engine.handleProviderFailure({
        providerKey: 'provider.b',
        reason: `client_error_${index + 1}`,
        fatal: true,
        statusCode: 400,
        affectsHealth: true
      });
    }
    engine.handleProviderFailure({
      providerKey: 'provider.a',
      reason: 'client_error',
      fatal: true,
      statusCode: 400,
      affectsHealth: true
    });

    expect(routeOnce(engine, 'req-last-provider-fatal')).toBe('provider.a');
  });

});
