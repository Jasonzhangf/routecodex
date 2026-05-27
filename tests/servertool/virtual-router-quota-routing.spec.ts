import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

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

  it('does not let TS quotaView out-of-pool state override Rust route decision', () => {
    const engine = createEngine((key: string) => ({
      providerKey: key,
      inPool: key !== providerA,
      reason: key === providerA ? 'blacklist' : 'ok',
      priorityTier: 100
    }));
    const result = route(engine);
    expect(result.target.providerKey).toBe(providerA);
  });

  it('ignores TS quotaView transient keep-pool cooldown for route selection when Rust has no blocker', () => {
    const now = Date.now();
    const engine = createEngine((key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'cooldown',
          priorityTier: 100,
          cooldownUntil: now + 60_000,
          cooldownKeepsPool: true,
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
    expect(result.target.providerKey).toBe(providerA);
  });

  it('ignores TS quotaView hard cooldown for route selection when Rust has no blocker', () => {
    const now = Date.now();
    const engine = createEngine((key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: false,
          reason: 'cooldown',
          priorityTier: 100,
          cooldownUntil: now + 60_000,
          cooldownKeepsPool: false,
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
    expect(result.target.providerKey).toBe(providerA);
  });

  it('does not empty the route when the only provider has only TS quotaView keep-pool cooldown metadata', () => {
    const now = Date.now();
    const engine = new VirtualRouterEngine({
      quotaView: (key: string) => ({
        providerKey: key,
        inPool: true,
        reason: 'cooldown',
        priorityTier: 100,
        cooldownUntil: now + 60_000,
        cooldownKeepsPool: true,
        blacklistUntil: null
      })
    } as any);
    engine.initialize({
      routing: {
        default: [
          {
            id: 'primary',
            targets: [providerA],
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
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const result = route(engine);
    expect(result.target.providerKey).toBe(providerA);
  });

  it('does not empty the route for the only provider when TS quotaView only reports error-decay metadata', () => {
    const now = Date.now();
    const engine = new VirtualRouterEngine({
      quotaView: (key: string) => ({
        providerKey: key,
        inPool: true,
        reason: 'cooldown',
        priorityTier: 100,
        cooldownUntil: now + 60_000,
        cooldownKeepsPool: true,
        blacklistUntil: null,
        consecutiveErrorCount: 1
      })
    } as any);
    engine.initialize({
      routing: {
        default: [
          {
            id: 'primary',
            targets: [providerA],
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
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const result = route(engine);
    expect(result.target.providerKey).toBe(providerA);
  });

  it('does not empty a single-provider route on stale TS quotaView cooldown residue', () => {
    const engine = createEngine((key: string) => ({
      providerKey: key,
      inPool: false,
      reason: 'cooldown',
      priorityTier: 100,
      cooldownUntil: null,
      blacklistUntil: null,
      lastErrorSeries: 'E5XX',
      lastErrorCode: 'WINDSURF_SERVICE_UNREACHABLE',
      consecutiveErrorCount: 3
    }));
    engine.initialize({
      routing: {
        default: [
          {
            id: 'single-stale-cooldown',
            targets: [providerA],
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
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const result = route(engine);
    expect(result.target.providerKey).toBe(providerA);
  });

  it('does not empty gateway 10000 when mini27 is keep-pool cooldown and mimo is healthy', () => {
    const now = Date.now();
    const mini27 = 'mini27.key1.MiniMax-M2.7';
    const mimo = 'mimo.key1.mimo-v2.5-pro';
    const engine = new VirtualRouterEngine({
      quotaView: (key: string) => {
        if (key === mini27) {
          return {
            providerKey: key,
            inPool: true,
            reason: 'cooldown',
            priorityTier: 100,
            cooldownUntil: now + 60_000,
            cooldownKeepsPool: true,
            blacklistUntil: null,
            lastErrorSeries: 'EOTHER',
            lastErrorCode: 'EXTERNAL_ERROR',
            consecutiveErrorCount: 4
          };
        }
        if (key === mimo) {
          return {
            providerKey: key,
            inPool: true,
            reason: 'ok',
            priorityTier: 100,
            cooldownUntil: null,
            blacklistUntil: null
          };
        }
        return null;
      }
    } as any);
    engine.initialize({
      routing: {
        tools: [{ id: 'gateway-coding-10000-tools', targets: [mini27, mimo], priority: 200, mode: 'priority' }]
      },
      providers: {
        [mini27]: {
          providerKey: mini27,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'mini27.key1',
          modelId: 'MiniMax-M2.7'
        },
        [mimo]: {
          providerKey: mimo,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-responses',
          runtimeKey: 'mimo.key1',
          modelId: 'mimo-v2.5-pro'
        }
      },
      classifier: {},
      loadBalancing: { strategy: 'priority' },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const result = engine.route(
      {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'use tools' }],
        tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
        metadata: { originalEndpoint: '/v1/responses' }
      } as any,
      {
        requestId: 'req_gateway_10000_keep_pool',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any
    );
    expect([mini27, mimo]).toContain(result.target.providerKey);
  });
});
