import { describe, expect, it } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

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
    { requestId } as any
  ).target.providerKey;
}

describe('virtual router native last-provider guard', () => {
  it('does not cooldown the last remaining available provider', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig(['provider.a']));

    engine.handleProviderFailure({
      providerKey: 'provider.a',
      reason: 'upstream_error',
      fatal: false,
      statusCode: 502,
      affectsHealth: true,
      cooldownOverrideMs: 30_000
    });

    expect(routeOnce(engine, 'req-last-provider-nonfatal')).toBe('provider.a');
  });

  it('does not trip the last remaining available provider even on fatal events', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig(['provider.a', 'provider.b']));

    engine.markProviderCooldown('provider.b', 60_000);
    engine.handleProviderFailure({
      providerKey: 'provider.a',
      reason: 'client_error',
      fatal: true,
      statusCode: 400,
      affectsHealth: true,
      cooldownOverrideMs: 120_000
    });

    expect(routeOnce(engine, 'req-last-provider-fatal')).toBe('provider.a');
  });

});
