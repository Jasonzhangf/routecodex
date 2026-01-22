import { jest } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('virtual-router context-weighted selection (safe window compensation)', () => {
  test('prefers smaller effective safe windows early (Claude < GPT < Gemini)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const claude = 'claude.key1.claude';
      const gpt = 'openai.key1.gpt';
      const gemini = 'gemini.key1.gemini';

      const quotaView = (providerKey: string) => ({
        providerKey,
        inPool: true,
        priorityTier: 100,
        selectionPenalty: 0,
        cooldownUntil: null,
        blacklistUntil: null,
        lastErrorAtMs: null,
        consecutiveErrorCount: 0
      });

      const engine = new VirtualRouterEngine({ quotaView });
      engine.initialize({
        routing: {
          default: [{ id: 'rr', targets: [claude, gpt, gemini], priority: 100, mode: 'round-robin' }]
        },
        providers: {
          [claude]: {
            providerKey: claude,
            providerType: 'responses',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'openai-responses',
            modelId: 'claude',
            maxContextTokens: 150_000
          },
          [gpt]: {
            providerKey: gpt,
            providerType: 'responses',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'openai-responses',
            modelId: 'gpt',
            maxContextTokens: 200_000
          },
          [gemini]: {
            providerKey: gemini,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini',
            maxContextTokens: 1_000_000
          }
        },
        classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
        contextRouting: { warnRatio: 0.9, hardLimit: false },
        loadBalancing: {
          strategy: 'round-robin',
          contextWeighted: { enabled: true, clientCapTokens: 200_000, gamma: 1, maxMultiplier: 2 }
        },
        health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
      } as any);

      const request: any = { model: 'any', messages: [{ role: 'user', content: 'hi' }], tools: [], parameters: {} };
      const metadata: any = {
        requestId: 'req_ctx_weighted',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        routeHint: 'default'
      };

      // Expected effective safe windows (warnRatio=0.9, clientCap=200k):
      // - Claude: 150k * 0.9 = 135k  -> multiplier ≈ 200/135 = 1.48 -> weight 148
      // - GPT:    200k * 0.9 = 180k  -> multiplier ≈ 200/180 = 1.11 -> weight 111
      // - Gemini: >200k (slack cancels reserve) -> safe=200k -> multiplier 1.0 -> weight 100
      const expected: Record<string, number> = { [claude]: 148, [gpt]: 111, [gemini]: 100 };
      const total = expected[claude] + expected[gpt] + expected[gemini];

      const counts: Record<string, number> = { [claude]: 0, [gpt]: 0, [gemini]: 0 };
      for (let i = 0; i < total; i += 1) {
        const picked = engine.route(request, metadata).target.providerKey;
        counts[picked] += 1;
      }

      expect(counts).toEqual(expected);
    } finally {
      logSpy.mockRestore();
    }
  });
});

