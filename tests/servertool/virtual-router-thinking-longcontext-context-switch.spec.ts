import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { computeRequestTokens } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

describe('virtual-router thinking overflow routes to longcontext', () => {
  it('routes fresh user input to longcontext when thinking pool overflows context', () => {
    const providerThinking = 'mock.thinking.gpt-5.2';
    const providerLong = 'mock.long.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'overflow token budget segment alpha beta gamma delta '.repeat(40_000)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');
    expect(estimated).toBeGreaterThan(180_000);

    const thinkingLimit = Math.max(64, Math.floor(estimated / 2));
    const longLimit = Math.max(thinkingLimit + 1, estimated * 2);

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        thinking: [{ id: 'thinking', targets: [providerThinking], priority: 100, mode: 'priority' }],
        longcontext: [{ id: 'longcontext', targets: [providerLong], priority: 100, mode: 'priority' }],
        default: [{ id: 'default', targets: [providerThinking], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerThinking]: {
          providerKey: providerThinking,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: thinkingLimit
        },
        [providerLong]: {
          providerKey: providerLong,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: longLimit
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'priority' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const metadata: any = {
      requestId: 'req_ctx_thinking_overflow_routes_longcontext',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      estimatedInputTokens: estimated
    };

    const decision = engine.route(request, metadata);
    expect(decision.decision.routeName).toBe('longcontext');
    expect(decision.target.providerKey).toBe(providerLong);
  });

  it('falls back to default when thinking overflows and no longcontext route is available', () => {
    const providerThinking = 'mock.thinking.gpt-5.2';
    const providerDefault = 'mock.default.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'overflow token budget segment alpha beta gamma delta '.repeat(40_000)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');
    expect(estimated).toBeGreaterThan(180_000);

    const thinkingLimit = Math.max(64, Math.floor(estimated / 2));
    const defaultLimit = Math.max(thinkingLimit + 1, estimated * 2);

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        thinking: [{ id: 'thinking', targets: [providerThinking], priority: 100, mode: 'priority' }],
        default: [{ id: 'default', targets: [providerDefault], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerThinking]: {
          providerKey: providerThinking,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: thinkingLimit
        },
        [providerDefault]: {
          providerKey: providerDefault,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: defaultLimit
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'priority' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const metadata: any = {
      requestId: 'req_ctx_thinking_overflow_falls_default',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      estimatedInputTokens: estimated
    };

    const decision = engine.route(request, metadata);
    expect(decision.decision.routeName).toBe('default');
    expect(decision.target.providerKey).toBe(providerDefault);
  });

  it('routes to longcontext without relying on routeHint override when classifier emits thinking plus longcontext', () => {
    const providerThinking = 'mock.thinking.nohint.gpt-5.2';
    const providerLong = 'mock.long.nohint.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'overflow token budget segment alpha beta gamma delta '.repeat(40_000)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');
    expect(estimated).toBeGreaterThan(180_000);

    const thinkingLimit = Math.max(64, Math.floor(estimated / 2));
    const longLimit = Math.max(thinkingLimit + 1, estimated * 2);

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        thinking: [{ id: 'thinking', targets: [providerThinking], priority: 100, mode: 'priority' }],
        longcontext: [{ id: 'longcontext', targets: [providerLong], priority: 100, mode: 'priority' }],
        default: [{ id: 'default', targets: [providerThinking], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerThinking]: {
          providerKey: providerThinking,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: thinkingLimit
        },
        [providerLong]: {
          providerKey: providerLong,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: longLimit
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'priority' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const metadata: any = {
      requestId: 'req_ctx_thinking_overflow_routes_longcontext_nohint',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      estimatedInputTokens: estimated
    };

    const decision = engine.route(request, metadata);
    expect(decision.decision.routeName).toBe('longcontext');
    expect(decision.target.providerKey).toBe(providerLong);
    expect(decision.decision.reasoning).toContain('longcontext:token-threshold');
  });

  it('stays on thinking when longcontext threshold is hit but thinking provider still has enough context', () => {
    const providerThinking = 'mock.thinking.enough.gpt-5.2';
    const providerLong = 'mock.long.enough.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'overflow token budget segment alpha beta gamma delta '.repeat(40_000)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');
    expect(estimated).toBeGreaterThan(180_000);

    const thinkingLimit = estimated * 2;
    const longLimit = estimated * 3;

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        thinking: [{ id: 'thinking', targets: [providerThinking], priority: 100, mode: 'priority' }],
        longcontext: [{ id: 'longcontext', targets: [providerLong], priority: 100, mode: 'priority' }],
        default: [{ id: 'default', targets: [providerThinking], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerThinking]: {
          providerKey: providerThinking,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: thinkingLimit
        },
        [providerLong]: {
          providerKey: providerLong,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: longLimit
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'priority' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const metadata: any = {
      requestId: 'req_ctx_thinking_threshold_but_thinking_safe',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'thinking',
      estimatedInputTokens: estimated
    };

    const decision = engine.route(request, metadata);
    expect(decision.decision.routeName).toBe('thinking');
    expect(decision.target.providerKey).toBe(providerThinking);
    expect(decision.decision.reasoning).toContain('longcontext:token-threshold');
    expect(decision.decision.reasoning).toContain('route_hint:thinking');
  });
});
