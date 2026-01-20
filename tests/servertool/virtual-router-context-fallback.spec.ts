import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { computeRequestTokens } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/token-estimator.js';

describe('virtual-router context routing fallback', () => {
  it('falls back to risky providers when safe providers are unavailable (e.g. 429 cooldown)', () => {
    const providerBig = 'mock.big.gpt-5.2';
    const providerSmall = 'mock.small.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'hello '.repeat(400)
        }
      ],
      tools: [],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');

    // Make small provider "risky" (>=90% but <100%), and big provider "safe".
    const smallLimit = Math.max(64, Math.ceil(estimated / 0.95));
    const bigLimit = Math.max(smallLimit + 1, smallLimit * 3);

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        default: [{ id: 'primary', targets: [providerBig, providerSmall], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerBig]: {
          providerKey: providerBig,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: bigLimit
        },
        [providerSmall]: {
          providerKey: providerSmall,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: smallLimit
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
      requestId: 'req_ctx_fallback',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default'
    };

    const first = engine.route(request, metadata);
    expect(first.target.providerKey).toBe(providerBig);

    // Simulate rate limit (429) on the safe provider: it should become unavailable.
    engine.handleProviderFailure({
      providerKey: providerBig,
      reason: 'rate_limit',
      fatal: false,
      statusCode: 429
    });

    const second = engine.route(request, metadata);
    expect(second.target.providerKey).toBe(providerSmall);
  });
});

