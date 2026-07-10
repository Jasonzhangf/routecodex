import { VirtualRouterEngine } from '../sharedmodule/helpers/virtual-router-engine-direct-native.js';

describe('virtual-router longcontext fallback', () => {
  it('keeps longcontext route when longcontext pool is still available after non-fatal 429', () => {
    const providerLong = 'mock.long.gpt-5.2';
    const providerDefault = 'mock.default.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        longcontext: [{ id: 'long', targets: [providerLong], priority: 100, mode: 'priority' }],
        default: [{ id: 'default', targets: [providerDefault], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerLong]: {
          providerKey: providerLong,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: 200_000
        },
        [providerDefault]: {
          providerKey: providerDefault,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: 64_000
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
      requestId: 'req_longcontext_fallback',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'longcontext'
    };

    const first = engine.route(request, metadata);
    expect(first.target.providerKey).toBe(providerLong);

    engine.handleProviderFailure({
      providerKey: providerLong,
      reason: 'rate_limit',
      fatal: false,
      statusCode: 429
    });

    const second = engine.route(request, metadata);
    expect(second.target.providerKey).toBe(providerLong);
  });
});
