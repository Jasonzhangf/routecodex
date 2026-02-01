import { jest } from '@jest/globals';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('VirtualRouterEngine antigravity alias session lease', () => {
  test('does not share the same alias across different sessions within cooldown', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = jest.spyOn(Date, 'now');

    const a = 'antigravity.aliasA.gemini-3-pro-high';
    const b = 'antigravity.aliasB.gemini-3-pro-high';

    try {
      const engine = new VirtualRouterEngine();
      engine.initialize({
        routing: {
          default: [{ id: 'primary', targets: [a, b], priority: 1, mode: 'round-robin' }]
        },
        providers: {
          [a]: {
            providerKey: a,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini-3-pro-high'
          },
          [b]: {
            providerKey: b,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini-3-pro-high'
          }
        },
        classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
        loadBalancing: { strategy: 'round-robin', aliasSelection: { sessionLeaseCooldownMs: 5 * 60_000 } },
        contextRouting: { warnRatio: 0.9, hardLimit: false },
        health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
      } as any);

      const request: any = { model: 'gemini-3-pro-high', messages: [{ role: 'user', content: 'hi' }], tools: [] };

      nowSpy.mockReturnValue(1_000_000);
      const pickedA = engine.route(request, {
        requestId: 'req_sess_a_1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default',
        sessionId: 'sessionA'
      } as any).target.providerKey;

      nowSpy.mockReturnValue(1_000_010);
      const pickedB = engine.route(request, {
        requestId: 'req_sess_b_1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default',
        sessionId: 'sessionB'
      } as any).target.providerKey;

      expect(pickedA).not.toBe(pickedB);
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('avoids reusing the same alias by falling back to default when possible', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = jest.spyOn(Date, 'now');

    const a = 'antigravity.aliasA.gemini-3-pro-high';
    const cooldown = 5 * 60_000;
    const fallback = 'tab.key1.gpt-5.2';

    try {
      const engine = new VirtualRouterEngine();
      engine.initialize({
        routing: {
          thinking: [{ id: 'primary', targets: [a], priority: 1, mode: 'round-robin' }],
          default: [{ id: 'fallback', targets: [fallback], priority: 1, mode: 'round-robin' }]
        },
        providers: {
          [a]: {
            providerKey: a,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini-3-pro-high'
          },
          [fallback]: {
            providerKey: fallback,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gpt-5.2'
          }
        },
        classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
        loadBalancing: { strategy: 'round-robin', aliasSelection: { sessionLeaseCooldownMs: cooldown } },
        contextRouting: { warnRatio: 0.9, hardLimit: false },
        health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
      } as any);

      const request: any = { model: 'gemini-3-pro-high', messages: [{ role: 'user', content: 'hi' }], tools: [] };

      nowSpy.mockReturnValue(2_000_000);
      expect(
        engine.route(request, {
          requestId: 'req_sess_a_only_1',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          routeHint: 'thinking',
          sessionId: 'sessionA'
        } as any).target.providerKey
      ).toBe(a);

      nowSpy.mockReturnValue(2_000_010);
      expect(
        engine.route(request, {
          requestId: 'req_sess_b_only_1',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          routeHint: 'thinking',
          sessionId: 'sessionB'
        } as any).target.providerKey
      ).toBe(fallback);

      nowSpy.mockReturnValue(2_000_000 + cooldown + 1);
      expect(
        engine.route(request, {
          requestId: 'req_sess_b_only_2',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          routeHint: 'thinking',
          sessionId: 'sessionB'
        } as any).target.providerKey
      ).toBe(a);
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('default route does not fail when all antigravity aliases are busy (fallback best-effort)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = jest.spyOn(Date, 'now');

    const a = 'antigravity.aliasA.gemini-3-pro-high';
    const b = 'antigravity.aliasB.gemini-3-pro-high';
    const cooldown = 5 * 60_000;

    try {
      const engine = new VirtualRouterEngine();
      engine.initialize({
        routing: {
          default: [{ id: 'primary', targets: [a, b], priority: 1, mode: 'round-robin' }]
        },
        providers: {
          [a]: {
            providerKey: a,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini-3-pro-high'
          },
          [b]: {
            providerKey: b,
            providerType: 'gemini',
            endpoint: 'https://example.invalid',
            auth: { type: 'apiKey', value: 'test' },
            outboundProfile: 'gemini-chat',
            modelId: 'gemini-3-pro-high'
          }
        },
        classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
        loadBalancing: { strategy: 'round-robin', aliasSelection: { sessionLeaseCooldownMs: cooldown } },
        contextRouting: { warnRatio: 0.9, hardLimit: false },
        health: { failureThreshold: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
      } as any);

      const request: any = { model: 'gemini-3-pro-high', messages: [{ role: 'user', content: 'hi' }], tools: [] };

      // SessionA leases aliasA, SessionB leases aliasB.
      nowSpy.mockReturnValue(3_000_000);
      const pickedA = engine.route(request, {
        requestId: 'req_a_1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default',
        sessionId: 'sessionA'
      } as any).target.providerKey;

      nowSpy.mockReturnValue(3_000_010);
      const pickedB = engine.route(request, {
        requestId: 'req_b_1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default',
        sessionId: 'sessionB'
      } as any).target.providerKey;

      expect(pickedA).not.toBe(pickedB);

      // SessionC arrives while both aliases are still within cooldown. Default route must still select something.
      nowSpy.mockReturnValue(3_000_020);
      const pickedC = engine.route(request, {
        requestId: 'req_c_1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default',
        sessionId: 'sessionC'
      } as any).target.providerKey;

      expect([a, b]).toContain(pickedC);
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
