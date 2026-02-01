import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

describe('virtual-router quotaView availability', () => {
  it('does not block in-pool targets due to stale health when quotaView is present', () => {
    const providerA = 'mock.a.gpt-5.2';
    const providerB = 'mock.b.gpt-5.2';

    const engine = new VirtualRouterEngine();
    engine.initialize({
      routing: {
        default: [
          {
            id: 'default-primary',
            mode: 'round-robin',
            priority: 100,
            targets: [providerA, providerB]
          }
        ]
      },
      providers: {
        [providerA]: {
          providerKey: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: 32_000
        },
        [providerB]: {
          providerKey: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'apiKey', value: 'test' },
          outboundProfile: 'openai-responses',
          modelId: 'gpt-5.2',
          maxContextTokens: 32_000
        }
      },
      classifier: { longContextThresholdTokens: 180000, thinkingKeywords: [], backgroundKeywords: [] },
      loadBalancing: { strategy: 'round-robin' },
      contextRouting: { warnRatio: 0.9, hardLimit: false },
      health: { maxFailures: 3, cooldownMs: 5_000, fatalCooldownMs: 10_000 }
    } as any);

    // Simulate a stale/tripped health snapshot (e.g. previous process run) while quota still shows "active".
    engine.handleProviderFailure({ providerKey: providerA, reason: 'auth', fatal: true, statusCode: 403 });
    engine.handleProviderFailure({ providerKey: providerB, reason: 'auth', fatal: true, statusCode: 403 });

    engine.updateDeps({
      quotaView: (key: string) => ({
        providerKey: key,
        inPool: true,
        priorityTier: 100
      })
    });

    const request: any = {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      parameters: {},
      metadata: { originalEndpoint: '/v1/responses' }
    };
    const metadata: any = {
      requestId: 'req_quota_health_override',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    };

    const decision = engine.route(request, metadata);
    expect([providerA, providerB]).toContain(decision.target.providerKey);
  });
});

