import { selectProviderImpl } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection.js';

describe('virtual-router quotaView routing', () => {
  const routeName = 'default';
  const providerA = 'mock.providerA.model';
  const providerB = 'mock.providerB.model';

  function createDeps(quotaView?: (providerKey: string) => unknown) {
    const routing = {
      [routeName]: [
        {
          id: 'primary',
          targets: [providerA, providerB],
          priority: 100
        }
      ]
    };
    const providerRegistry = {
      get: (key: string) => ({
        providerKey: key,
        providerType: 'responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'default'
      }),
      listProviderKeys: (providerId?: string) => {
        if (providerId === 'mock.providerA') return [providerA];
        if (providerId === 'mock.providerB') return [providerB];
        return [providerA, providerB];
      },
      resolveRuntimeKeyByAlias: () => null,
      resolveRuntimeKeyByIndex: () => null
    };
    const healthManager = {
      isAvailable: () => true
    };
    const contextAdvisor = {
      classify: (targets: string[]) => ({
        safe: targets,
        risky: [] as string[],
        overflow: [] as string[]
      })
    };
    const loadBalancer = {
      select: (options: { candidates: string[] }) =>
        options.candidates.length ? options.candidates[0] : null
    };
    return {
      routing,
      providerRegistry,
      healthManager,
      contextAdvisor,
      loadBalancer,
      isProviderCoolingDown: () => false,
      resolveStickyKey: () => undefined,
      quotaView
    };
  }

  function createBaseFeatures() {
    return {
      requestId: 'req_test',
      model: 'gpt-5.1',
      totalMessages: 0,
      userTextSample: '',
      toolCount: 0,
      hasTools: false,
      hasToolCallResponses: false,
      hasVisionTool: false,
      hasImageAttachment: false,
      hasWebTool: false,
      hasCodingTool: false,
      hasThinkingKeyword: false,
      estimatedTokens: 128,
      metadata: {}
    };
  }

  function createBaseState(): any {
    return {
      forcedTarget: null,
      stickyTarget: null,
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, Set<string | number>>(),
      disabledModels: new Map<string, Set<string>>()
    };
  }

  const baseMetadata: any = {
    requestId: 'req_test',
    entryEndpoint: '/v1/responses',
    processMode: 'chat',
    stream: true,
    direction: 'request'
  };

  const baseClassification: any = {
    routeName,
    confidence: 1,
    reasoning: 'test',
    fallback: false
  };

  it('falls back to first target when quotaView is not provided', () => {
    const deps = createDeps();
    const features = createBaseFeatures();
    const state = createBaseState();
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerA);
  });

  it('excludes providers that are not inPool according to quotaView', () => {
    const quotaView = (key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: false,
          reason: 'blacklist',
          priorityTier: 100
        };
      }
      if (key === providerB) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'ok',
          priorityTier: 100
        };
      }
      return null;
    };
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerB);
  });

  it('prefers lower priorityTier providers when multiple are eligible', () => {
    const quotaView = (key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'ok',
          priorityTier: 200
        };
      }
      if (key === providerB) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'ok',
          priorityTier: 10
        };
      }
      return null;
    };
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerB);
  });

  it('does not allow quotaView to empty the default route (quota bypass)', () => {
    const quotaView = (key: string) => ({
      providerKey: key,
      inPool: false,
      reason: 'quotaDepleted',
      priorityTier: 100
    });
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    // With quota bypass enabled for default route, selection falls back to the load balancer.
    expect(result.providerKey).toBe(providerA);
  });

  it('ignores providers still in cooldown or blacklist windows', () => {
    const now = Date.now();
    const quotaView = (key: string) => {
      if (key === providerA) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'cooldown',
          priorityTier: 50,
          cooldownUntil: now + 60_000,
          blacklistUntil: null
        };
      }
      if (key === providerB) {
        return {
          providerKey: key,
          inPool: true,
          reason: 'ok',
          priorityTier: 50,
          cooldownUntil: null,
          blacklistUntil: null
        };
      }
      return null;
    };
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerB);
  });

  it('applies quotaView to forcedTarget resolution', () => {
    const quotaView = (key: string) => {
      if (key === providerA) {
        return { providerKey: key, inPool: false, reason: 'quotaDepleted', priorityTier: 0 };
      }
      return { providerKey: key, inPool: true, reason: 'ok', priorityTier: 0 };
    };
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    state.forcedTarget = { provider: 'mock.providerA' };
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerA);
  });

  it('applies quotaView to stickyTarget resolution', () => {
    const quotaView = (key: string) => {
      if (key === providerA) {
        return { providerKey: key, inPool: false, reason: 'blacklist', priorityTier: 0 };
      }
      return { providerKey: key, inPool: true, reason: 'ok', priorityTier: 0 };
    };
    const deps = createDeps(quotaView);
    const features = createBaseFeatures();
    const state = createBaseState();
    state.stickyTarget = { provider: 'mock.providerA' };
    const result = selectProviderImpl(
      routeName,
      baseMetadata,
      baseClassification,
      features,
      state,
      deps as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerB);
  });

  it('falls back to default route when non-default route has only one target and quota blocks it', () => {
    const routing = {
      coding: [
        {
          id: 'primary',
          targets: [providerA],
          priority: 100
        }
      ],
      default: [
        {
          id: 'primary',
          targets: [providerB],
          priority: 100
        }
      ]
    };
    const providerRegistry = {
      get: (key: string) => ({
        providerKey: key,
        providerType: 'responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'default'
      }),
      listProviderKeys: () => [providerA, providerB],
      resolveRuntimeKeyByAlias: () => null,
      resolveRuntimeKeyByIndex: () => null
    };
    const healthManager = { isAvailable: () => true };
    const contextAdvisor = {
      classify: (targets: string[]) => ({
        safe: targets,
        risky: [] as string[],
        overflow: [] as string[]
      })
    };
    const loadBalancer = {
      select: (options: { candidates: string[] }) => (options.candidates.length ? options.candidates[0] : null)
    };
    const quotaView = (key: string) => {
      if (key === providerA) {
        return { providerKey: key, inPool: false, reason: 'quotaDepleted', priorityTier: 0 };
      }
      if (key === providerB) {
        return { providerKey: key, inPool: true, reason: 'ok', priorityTier: 0 };
      }
      return null;
    };

    const features = createBaseFeatures();
    const state = createBaseState();
    const classification: any = {
      routeName: 'coding',
      confidence: 1,
      reasoning: 'test',
      fallback: false,
      candidates: ['coding', 'default']
    };
    const metadata: any = { ...baseMetadata };

    const result = selectProviderImpl(
      'coding',
      metadata,
      classification,
      features,
      state,
      {
        routing,
        providerRegistry,
        healthManager,
        contextAdvisor,
        loadBalancer,
        isProviderCoolingDown: () => false,
        resolveStickyKey: () => undefined,
        quotaView
      } as any,
      { routingState: state }
    );
    expect(result.providerKey).toBe(providerB);
    expect(result.routeUsed).toBe('default');
  });
});
