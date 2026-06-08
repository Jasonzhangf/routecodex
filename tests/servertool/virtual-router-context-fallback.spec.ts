import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';
import { computeRequestTokens } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

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

    // Simulate an already-applied provider cooldown: the risky provider remains routable.
    engine.markProviderCooldown(providerBig, 5_000);

    const second = engine.route(request, metadata);
    expect(second.target.providerKey).toBe(providerSmall);
  });

  it('does not exhaust default route when all candidates exceed maxContextTokens (hardLimit=false)', () => {
    const providerA = 'mock.overflowA.gpt-5.2';
    const providerB = 'mock.overflowB.gpt-5.2';

    const request: any = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: 'x'.repeat(50_000)
        }
      ],
      tools: [],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const estimated = computeRequestTokens(request, '');

    // Force both providers into overflow by setting maxContextTokens below estimated tokens.
    const overflowLimit = Math.max(32, Math.floor(estimated / 2));

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        default: [{ id: 'primary', targets: [providerA, providerB], priority: 100, mode: 'priority' }]
      },
      providers: {
        [providerA]: {
          providerKey: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: overflowLimit
        },
        [providerB]: {
          providerKey: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: overflowLimit
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
      requestId: 'req_ctx_overflow_soft',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default'
    };

    const picked = engine.route(request, metadata).target.providerKey;
    expect([providerA, providerB]).toContain(picked);
  });

  it('keeps unique provider routable even when routing filters would otherwise exhaust pool', () => {
    const soleProvider = 'mock.sole.gpt-5.2';

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        default: [{ id: 'primary', targets: [soleProvider], priority: 100, mode: 'priority' }]
      },
      providers: {
        [soleProvider]: {
          providerKey: soleProvider,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          serverToolsDisabled: true
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'priority' },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    const request: any = {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'tool request' }],
      tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };

    const metadata: any = {
      requestId: 'req_ctx_single_provider_guard',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default',
      serverToolRequired: true,
      excludedProviderKeys: [soleProvider]
    };

    expect(() => engine.route(request, metadata)).toThrow(
      'No available providers after applying routing instructions'
    );
  });
});
