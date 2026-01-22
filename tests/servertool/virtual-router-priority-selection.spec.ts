import { jest } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('virtual-router priority pool selection', () => {
  test('priority pools do not round-robin when all targets are healthy', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const primary = 'mock1.primary.gpt-5.2';
    const secondary = 'mock2.secondary.gpt-5.2';

    try {
      const engine = new VirtualRouterEngine();
      engine.initialize({
        routing: {
          default: [{ id: 'primary', targets: [primary, secondary], priority: 100, mode: 'priority' }]
        },
        providers: {
          [primary]: {
            providerKey: primary,
            providerType: 'responses',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'openai-responses',
            modelId: 'gpt-5.2'
          },
          [secondary]: {
            providerKey: secondary,
            providerType: 'responses',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'openai-responses',
            modelId: 'gpt-5.2'
          }
        },
        classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
        loadBalancing: { strategy: 'round-robin' },
        contextRouting: { warnRatio: 0.9, hardLimit: false },
        health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
      } as any);

      const request: any = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }], tools: [], parameters: {} };
      const metadata: any = {
        requestId: 'req_priority_rr',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        routeHint: 'default'
      };

      const first = engine.route(request, metadata).target.providerKey;
      const second = engine.route(request, metadata).target.providerKey;
      const third = engine.route(request, metadata).target.providerKey;

      expect(first).toBe(primary);
      expect(second).toBe(primary);
      expect(third).toBe(primary);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('priority pools can be shifted by quota selectionPenalty (soft)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const primary = 'mock1.primary.gpt-5.2';
    const secondary = 'mock2.secondary.gpt-5.2';

    try {
      const quotaView = (providerKey: string) => {
        if (providerKey === primary) {
          return {
            providerKey,
            inPool: true,
            priorityTier: 100,
            selectionPenalty: 9,
            cooldownUntil: null,
            blacklistUntil: null,
            lastErrorAtMs: Date.now(),
            consecutiveErrorCount: 9
          };
        }
        if (providerKey === secondary) {
          return {
            providerKey,
            inPool: true,
            priorityTier: 100,
            selectionPenalty: 0,
            cooldownUntil: null,
            blacklistUntil: null,
            lastErrorAtMs: null,
            consecutiveErrorCount: 0
          };
        }
        return null;
      };

      const engine = new VirtualRouterEngine({ quotaView });
      engine.initialize({
        routing: {
          default: [{ id: 'primary', targets: [primary, secondary], priority: 100, mode: 'priority' }]
        },
        providers: {
          [primary]: {
            providerKey: primary,
            providerType: 'responses',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'openai-responses',
            modelId: 'gpt-5.2'
          },
          [secondary]: {
            providerKey: secondary,
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
        requestId: 'req_priority_penalty',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        routeHint: 'default'
      };

      expect(engine.route(request, metadata).target.providerKey).toBe(primary);

      // Increase penalty until it cancels the 10-point group gap: 100 - 10 == 90.
      const quotaViewPenalty10 = (providerKey: string) => {
        const entry = quotaView(providerKey);
        if (entry && providerKey === primary) {
          return { ...entry, selectionPenalty: 10, consecutiveErrorCount: 10 };
        }
        return entry;
      };
      engine.updateDeps({ quotaView: quotaViewPenalty10 });

      expect(engine.route(request, metadata).target.providerKey).toBe(secondary);
    } finally {
      logSpy.mockRestore();
    }
  });
});
