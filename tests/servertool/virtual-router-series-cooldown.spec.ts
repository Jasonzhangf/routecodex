import { RateLimitBackoffManager, RateLimitCooldownError } from '../../src/providers/core/runtime/rate-limit-manager.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';
import type {
  VirtualRouterConfig,
  ProviderErrorEvent
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';

describe('Virtual router series cooldown', () => {
  it('blacklists an entire model series after repeated 429s', () => {
    const manager = new RateLimitBackoffManager([10, 20], 50);
    const bucket = 'gemini.alias2.gemini-3-pro-high';
    const model = 'gemini-3-pro-high';

    const first = manager.record429(bucket, model);
    expect(first.seriesBlacklisted).toBe(false);

    const second = manager.record429(bucket, model);
    expect(second.seriesBlacklisted).toBe(true);

    const error = manager.buildThrottleError({ providerKey: bucket, model });
    expect(error).toBeInstanceOf(RateLimitCooldownError);
    expect(error?.message).toContain('series');
  });
});

describe('VirtualRouterEngine series cooldown handling', () => {
  const providerA = 'gemini.alias1.gemini-3-pro-high';
  const providerB = 'gemini.alias2.gemini-3-pro-high';

  const baseConfig: VirtualRouterConfig = {
    routing: {
      default: [
        {
          id: 'primary',
          targets: [providerA, providerB],
          priority: 1
        }
      ]
    },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:a',
        modelId: 'gemini-3-pro-high',
        series: 'gemini-pro'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'gemini',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test' },
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:b',
        modelId: 'gemini-3-pro-high',
        series: 'gemini-pro'
      }
    },
    classifier: {}
  };

  it('trips only the current providerKey when series cooldown signal targets that key', () => {
    const engine = new VirtualRouterEngine();
    engine.initialize(baseConfig);
    const event: ProviderErrorEvent = {
      code: 'HTTP_429',
      message: 'Rate limit',
      stage: 'provider.http',
      runtime: {
        requestId: 'req_test',
        providerKey: providerA
      },
      timestamp: Date.now(),
      details: {
        virtualRouterSeriesCooldown: {
          providerId: 'gemini.alias1',
          providerKey: providerA,
          model: 'gemini-3-pro-high',
          series: 'gemini-pro',
          cooldownMs: 60_000
        }
      }
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).toBe('tripped');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });

  it('keeps targeted Rust health trip active even when quotaView is enabled', () => {
    const quotaView = (key: string) => ({
      providerKey: key,
      inPool: true,
      reason: 'ok',
      priorityTier: 100,
      cooldownUntil: null,
      blacklistUntil: null
    });
    const engine = new VirtualRouterEngine({ quotaView } as any);
    engine.initialize(baseConfig);

    const event: ProviderErrorEvent = {
      code: 'HTTP_429',
      message: 'Rate limit',
      stage: 'provider.http',
      runtime: {
        requestId: 'req_test_quota',
        providerKey: providerA
      },
      timestamp: Date.now(),
      details: {
        virtualRouterSeriesCooldown: {
          providerId: 'gemini.alias1',
          providerKey: providerA,
          model: 'gemini-3-pro-high',
          series: 'gemini-pro',
          cooldownMs: 60_000
        }
      }
    };

    engine.handleProviderError(event);

    const status = engine.getStatus().health;
    expect(status.find((entry) => entry.providerKey === providerA)?.state).toBe('tripped');
    expect(status.find((entry) => entry.providerKey === providerB)?.state).not.toBe('tripped');
  });
});
