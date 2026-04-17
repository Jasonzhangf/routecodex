import { describe, expect, it } from '@jest/globals';

import { selectProviderImpl } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection.js';
import { RouteLoadBalancer } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/load-balancer.js';

describe('virtual-router search route routing', () => {
  it('keeps search as an independent route and does not fall back to default when search exists', () => {
    const searchProvider = 'qwen.qwen3.6-plus';
    const defaultProvider = 'ali-coding-plan.key1.qwen3.6-plus';

    const routing = {
      default: [{ id: 'default-primary', targets: [defaultProvider], priority: 100 }],
      search: [{ id: 'search-primary', targets: [searchProvider], priority: 200 }]
    };

    const providerRegistry = {
      get: (key: string) => ({
        providerKey: key,
        providerType: 'responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-responses',
        modelId: key.split('.').slice(-1)[0] || 'unknown'
      }),
      hasCapability: () => false,
      listProviderKeys: () => [searchProvider, defaultProvider],
      resolveRuntimeKeyByAlias: () => null,
      resolveRuntimeKeyByIndex: () => null
    };

    const deps = {
      routing,
      providerRegistry,
      healthManager: {
        isAvailable: () => true,
        getSnapshot: () => []
      },
      contextAdvisor: {
        classify: (targets: string[]) => ({
          safe: targets,
          risky: [] as string[],
          overflow: [] as string[]
        }),
        getConfig: () => ({ warnRatio: 0.9, hardLimit: false })
      },
      loadBalancer: new RouteLoadBalancer({ strategy: 'round-robin' }),
      isProviderCoolingDown: () => false,
      resolveStickyKey: () => undefined,
      quotaView: undefined
    };

    const features: any = {
      requestId: 'req_search_alias',
      model: 'qwen3.6-plus',
      totalMessages: 0,
      userTextSample: '',
      toolCount: 0,
      hasTools: false,
      hasToolCallResponses: false,
      hasVisionTool: false,
      hasImageAttachment: false,
      hasVideoAttachment: false,
      hasRemoteVideoAttachment: false,
      hasCodingTool: false,
      hasThinkingKeyword: false,
      estimatedTokens: 128,
      metadata: {}
    };

    const state = {
      forcedTarget: null,
      stickyTarget: null,
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, Set<string | number>>(),
      disabledModels: new Map<string, Set<string>>()
    };

    const result = selectProviderImpl(
      'search',
      {
        requestId: 'req_search_alias',
        entryEndpoint: '/v1/responses',
        processMode: 'chat',
        stream: true,
        direction: 'request'
      } as any,
      {
        routeName: 'search',
        confidence: 1,
        reasoning: 'search continuation',
        fallback: false
      } as any,
      features,
      state as any,
      deps as any,
      { routingState: state as any }
    );

    expect(result.routeUsed).toBe('search');
    expect(result.providerKey).toBe(searchProvider);
  });
});
