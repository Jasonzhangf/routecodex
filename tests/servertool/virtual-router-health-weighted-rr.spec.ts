import { jest } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('virtual-router health-weighted round-robin (AWRR)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('reduces hit rate for a recently failing key but does not starve it', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-22T00:00:00.000Z'));

    const a = 'mockA.key1.gpt-5.2';
    const b = 'mockB.key1.gpt-5.2';

    const now = Date.now();
    const quotaView = (providerKey: string) => {
      if (providerKey === a) {
        return {
          providerKey,
          inPool: true,
          priorityTier: 100,
          selectionPenalty: 0,
          lastErrorAtMs: now,
          consecutiveErrorCount: 5,
          cooldownUntil: null,
          blacklistUntil: null
        };
      }
      if (providerKey === b) {
        return {
          providerKey,
          inPool: true,
          priorityTier: 100,
          selectionPenalty: 0,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          cooldownUntil: null,
          blacklistUntil: null
        };
      }
      return null;
    };

    const engine = new VirtualRouterEngine({ quotaView });
    engine.initialize({
      routing: { default: [{ id: 'rr', targets: [a, b], priority: 100, mode: 'round-robin' }] },
      providers: {
        [a]: {
          providerKey: a,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        },
        [b]: {
          providerKey: b,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        }
      },
      classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
      loadBalancing: {
        strategy: 'round-robin',
        healthWeighted: { enabled: true, baseWeight: 100, minMultiplier: 0.5, beta: 0.1, halfLifeMs: 10 * 60_000 }
      },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const request: any = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }], tools: [], parameters: {} };
    const metadata: any = {
      requestId: 'req_awrr',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default'
    };

    const counts: Record<string, number> = { [a]: 0, [b]: 0 };
    for (let i = 0; i < 150; i += 1) {
      const picked = engine.route(request, metadata).target.providerKey;
      counts[picked] += 1;
    }

    // With consecutiveErrorCount=5 and beta=0.1, multiplier hits the floor (0.5) -> weights 50 vs 100.
      expect(counts[a]).toBe(50);
      expect(counts[b]).toBe(100);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('recovers toward equal share as errors age out', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-22T00:00:00.000Z'));

    const a = 'mockA.key1.gpt-5.2';
    const b = 'mockB.key1.gpt-5.2';

    const now = Date.now();
    const oldErrorAt = now - 60 * 60_000;
    const quotaView = (providerKey: string) => {
      if (providerKey === a) {
        return {
          providerKey,
          inPool: true,
          priorityTier: 100,
          selectionPenalty: 0,
          lastErrorAtMs: oldErrorAt,
          consecutiveErrorCount: 5,
          cooldownUntil: null,
          blacklistUntil: null
        };
      }
      if (providerKey === b) {
        return {
          providerKey,
          inPool: true,
          priorityTier: 100,
          selectionPenalty: 0,
          lastErrorAtMs: null,
          consecutiveErrorCount: 0,
          cooldownUntil: null,
          blacklistUntil: null
        };
      }
      return null;
    };

    const engine = new VirtualRouterEngine({ quotaView });
    engine.initialize({
      routing: { default: [{ id: 'rr', targets: [a, b], priority: 100, mode: 'round-robin' }] },
      providers: {
        [a]: {
          providerKey: a,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        },
        [b]: {
          providerKey: b,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        }
      },
      classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
      loadBalancing: { strategy: 'round-robin', healthWeighted: { enabled: true } },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const request: any = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }], tools: [], parameters: {} };
    const metadata: any = {
      requestId: 'req_awrr_recovery',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default'
    };

    const counts: Record<string, number> = { [a]: 0, [b]: 0 };
    for (let i = 0; i < 200; i += 1) {
      const picked = engine.route(request, metadata).target.providerKey;
      counts[picked] += 1;
    }

    // After long enough time without new errors, weights converge (near-equal selection).
      expect(Math.abs(counts[a] - counts[b])).toBeLessThanOrEqual(4);
      expect(counts[a]).toBeGreaterThan(0);
      expect(counts[b]).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
