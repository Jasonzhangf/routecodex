import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('virtual-router quotaView routing', () => {
  const providerA = 'mock.providerA.model';
  const providerB = 'mock.providerB.model';

  function createEngine(quotaView?: (providerKey: string) => unknown): VirtualRouterEngine {
    const engine = new VirtualRouterEngine(quotaView ? ({ quotaView } as any) : undefined);
    engine.initialize({
      routing: {
        default: [
          {
            id: 'primary',
            targets: [providerA, providerB],
            priority: 100,
            mode: 'priority'
          }
        ]
      },
      providers: {
        [providerA]: {
          providerKey: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.1'
        },
        [providerB]: {
          providerKey: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.1'
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);
    return engine;
  }

  function route(engine: VirtualRouterEngine) {
    return engine.route(
      {
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { originalEndpoint: '/v1/responses' }
      } as any,
      {
        requestId: 'req_quota_routing',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any
    );
  }

  it('falls back to first target when quotaView is not provided', () => {
    const engine = createEngine();
    const result = route(engine);
    expect(result.target.providerKey).toBe(providerA);
  });

  it('excludes providers that are not inPool according to quotaView', () => {
    const engine = createEngine((key: string) => ({
      providerKey: key,
      inPool: key !== providerA,
      reason: key === providerA ? 'blacklist' : 'ok',
      priorityTier: 100
    }));
    const result = route(engine);
    expect(result.target.providerKey).toBe(providerB);
  });

  it('ignores providers still in cooldown windows even when inPool=true', () => {
    const now = Date.now();
    const engine = createEngine((key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'cooldown',
          priorityTier: 100,
          cooldownUntil: now + 60_000,
          blacklistUntil: null
        };
      }
      return {
        providerKey: key,
        inPool: true,
        reason: 'ok',
        priorityTier: 100,
        cooldownUntil: null,
        blacklistUntil: null
      };
    });
    const result = route(engine);
    expect(result.target.providerKey).toBe(providerB);
  });

  it('fails fast with cooldown hints when quotaView empties the route', () => {
    const now = Date.now();
    const engine = createEngine((key: string) => ({
      providerKey: key,
      inPool: false,
      reason: 'cooldown',
      priorityTier: 100,
      cooldownUntil: now + 1500,
      blacklistUntil: null
    }));

    try {
      route(engine);
      throw new Error('expected route to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VirtualRouterError);
      const err = error as VirtualRouterError & { details?: Record<string, unknown> };
      expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
      expect(typeof err.details?.minRecoverableCooldownMs).toBe('number');
      expect((err.details?.minRecoverableCooldownMs as number) > 0).toBe(true);
      expect(Array.isArray(err.details?.recoverableCooldownHints)).toBe(true);
    }
  });
});
