import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('virtual-router engine updateDeps', () => {
  it('applies quotaView updates after initialization', () => {
    const providerA = 'mock.providerA.gpt-5.2';
    const providerB = 'mock.providerB.gpt-5.2';

    const engine = new VirtualRouterEngine();
    const config: any = {
      routing: {
        default: [{ id: 'primary', targets: [providerA, providerB], priority: 100 }]
      },
      providers: {
        [providerA]: {
          providerKey: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        },
        [providerB]: {
          providerKey: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2'
        }
      },
      classifier: {
        longContextThresholdTokens: 180000,
        thinkingKeywords: [],
        backgroundKeywords: []
      },
      loadBalancing: { strategy: 'round-robin' },
      contextRouting: { warnRatio: 0.9, hardLimit: false }
    };

    const request: any = {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };

    const metadata: any = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      routeHint: 'default'
    };

    engine.initialize(config);
    const first = engine.route(request, metadata);
    expect(first.target.providerKey).toBe(providerA);

    engine.updateDeps({
      quotaView: (key: string) => {
        if (key === providerA) {
          return { providerKey: key, inPool: false, reason: 'blacklist', priorityTier: 0 };
        }
        if (key === providerB) {
          return { providerKey: key, inPool: true, reason: 'ok', priorityTier: 0 };
        }
        return null;
      }
    });

    engine.initialize(config);
    const second = engine.route(request, metadata);
    expect(second.target.providerKey).toBe(providerB);
  });
});

