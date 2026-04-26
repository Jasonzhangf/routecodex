import { describe, expect, test } from '@jest/globals';

import { ContextAdvisor } from '../../src/router/virtual-router/context-advisor.js';
import { selectProviderImpl } from '../../src/router/virtual-router/engine/routing-pools/index.js';
import { ProviderHealthManager } from '../../src/router/virtual-router/health-manager.js';
import { RouteLoadBalancer } from '../../src/router/virtual-router/load-balancer.js';
import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import type {
  ClassificationResult,
  RoutePoolTier,
  RouterMetadataInput,
  RoutingFeatures
} from '../../src/router/virtual-router/types.js';
import type { RoutingInstructionState } from '../../src/router/virtual-router/routing-instructions.js';

describe('virtual-router sticky capability guard', () => {
  const providerRegistry = new ProviderRegistry({
    'custom.1-186.glm-5': {
      providerKey: 'custom.1-186.glm-5',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'glm-5'
    } as any,
    'custom.2-173.minimax-m2.5': {
      providerKey: 'custom.2-173.minimax-m2.5',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'minimax-m2.5'
    } as any,
    'custom.3-138.minimax-m2.5': {
      providerKey: 'custom.3-138.minimax-m2.5',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'minimax-m2.5'
    } as any
  });

  const routing: Record<string, RoutePoolTier[]> = {
    multimodal: [
      {
        id: 'multimodal-primary',
        priority: 100,
        mode: 'priority',
        targets: ['custom.2-173.minimax-m2.5']
      }
    ],
    web_search: [
      {
        id: 'web-search-primary',
        priority: 100,
        mode: 'priority',
        targets: ['custom.3-138.minimax-m2.5']
      }
    ],
    default: [
      {
        id: 'default-primary',
        priority: 100,
        mode: 'priority',
        targets: ['custom.1-186.glm-5']
      }
    ]
  };

  function baseDeps() {
    const healthManager = new ProviderHealthManager();
    healthManager.registerProviders(providerRegistry.listKeys());
    return {
      routing,
      providerRegistry,
      healthManager,
      contextAdvisor: new ContextAdvisor(),
      loadBalancer: new RouteLoadBalancer({ strategy: 'round-robin' }),
      isProviderCoolingDown: () => false,
      resolveStickyKey: () => undefined
    };
  }

  function stickyState(): RoutingInstructionState {
    return {
      stickyTarget: { provider: 'custom', keyAlias: '1-186' },
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map()
    };
  }

  function buildFeatures(
    metadata: RouterMetadataInput,
    options?: { hasImageAttachment?: boolean; hasWebSearchToolDeclared?: boolean }
  ): RoutingFeatures {
    return {
      requestId: metadata.requestId,
      model: 'glm-5',
      totalMessages: 1,
      userTextSample: 'hello',
      toolCount: 0,
      hasTools: false,
      hasToolCallResponses: false,
      hasVisionTool: false,
      hasImageAttachment: options?.hasImageAttachment === true,
      hasWebTool: false,
      hasWebSearchToolDeclared: options?.hasWebSearchToolDeclared === true,
      hasCodingTool: false,
      hasThinkingKeyword: false,
      estimatedTokens: 64,
      latestMessageFromUser: true,
      metadata
    };
  }

  function buildClassification(routeName: string, candidates: string[]): ClassificationResult {
    return {
      routeName,
      confidence: 0.9,
      reasoning: routeName,
      fallback: false,
      candidates
    };
  }

  test('skips sticky exact target for image request when sticky model is not in multimodal routes', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-image' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification('multimodal', ['multimodal', 'default']),
      buildFeatures(metadata, { hasImageAttachment: true }),
      stickyState(),
      baseDeps()
    );

    expect(selection.providerKey).toBe('custom.2-173.minimax-m2.5');
    expect(selection.routeUsed).toBe('multimodal');
    expect(selection.poolId).toBe('multimodal-primary');
  });

  test('skips sticky exact target for web_search request when sticky model is not in web_search/search routes', () => {
    const metadata: RouterMetadataInput = {
      requestId: 'req-web-search',
      serverToolRequired: true
    };
    const selection = selectProviderImpl(
      'web_search',
      metadata,
      buildClassification('web_search', ['web_search', 'default']),
      buildFeatures(metadata, { hasWebSearchToolDeclared: true }),
      stickyState(),
      baseDeps()
    );

    expect(selection.providerKey).toBe('custom.3-138.minimax-m2.5');
    expect(selection.routeUsed).toBe('web_search');
    expect(selection.poolId).toBe('web-search-primary');
  });

  test('keeps sticky behavior for normal text requests', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-default' };
    const selection = selectProviderImpl(
      'default',
      metadata,
      buildClassification('default', ['default']),
      buildFeatures(metadata),
      stickyState(),
      baseDeps()
    );

    expect(selection.providerKey).toBe('custom.1-186.glm-5');
    expect(selection.routeUsed).toBe('default');
    expect(selection.poolId).toBe('sticky');
  });
});
