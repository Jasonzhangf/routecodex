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

describe('virtual-router qwen3.5-plus multimodal capability', () => {
  const providerRegistry = new ProviderRegistry({
    'qwen.1.qwen3.5-plus': {
      providerKey: 'qwen.1.qwen3.5-plus',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'qwen3.5-plus',
      modelCapabilities: {
        'qwen3.5-plus': ['multimodal']
      }
    } as any,
    'qwen.1.qwen3.5-omni-plus': {
      providerKey: 'qwen.1.qwen3.5-omni-plus',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'qwen3.5-omni-plus',
      modelCapabilities: {
        'qwen3.5-omni-plus': ['video', 'multimodal']
      }
    } as any
  });

  const routing: Record<string, RoutePoolTier[]> = {
    multimodal: [
      {
        id: 'multimodal-primary',
        priority: 100,
        mode: 'priority',
        targets: ['qwen.1.qwen3.5-plus']
      }
    ],
    video: [
      {
        id: 'video-primary',
        priority: 100,
        mode: 'priority',
        targets: ['qwen.1.qwen3.5-omni-plus']
      }
    ],
    default: [
      {
        id: 'default-primary',
        priority: 100,
        mode: 'priority',
        targets: ['qwen.1.qwen3.5-plus']
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

  function idleState(): RoutingInstructionState {
    return {
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map()
    };
  }

  function buildFeatures(
    metadata: RouterMetadataInput,
    media?: { hasVideo?: boolean; hasRemoteVideo?: boolean; hasLocalVideo?: boolean }
  ): RoutingFeatures {
    return {
      requestId: metadata.requestId,
      model: 'qwen.qwen3.5-plus',
      totalMessages: 1,
      userTextSample: 'describe media',
      toolCount: 0,
      hasTools: false,
      hasToolCallResponses: false,
      hasVisionTool: false,
      hasImageAttachment: true,
      hasVideoAttachment: media?.hasVideo === true,
      hasRemoteVideoAttachment: media?.hasRemoteVideo === true,
      hasLocalVideoAttachment: media?.hasLocalVideo === true,
      hasWebTool: false,
      hasCodingTool: false,
      hasThinkingKeyword: false,
      estimatedTokens: 128,
      latestMessageFromUser: true,
      metadata
    };
  }

  function buildClassification(): ClassificationResult {
    return {
      routeName: 'multimodal',
      confidence: 0.9,
      reasoning: 'multimodal',
      fallback: false,
      candidates: ['multimodal', 'default']
    };
  }

  test('routes image requests to qwen3.5-plus in multimodal pool', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-qwen-image' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification(),
      buildFeatures(metadata),
      idleState(),
      baseDeps()
    );

    expect(selection.routeUsed).toBe('multimodal');
    expect(selection.providerKey).toBe('qwen.1.qwen3.5-plus');
  });

  test('routes remote video requests to video capability route', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-qwen-remote-video' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification(),
      buildFeatures(metadata, { hasVideo: true, hasRemoteVideo: true, hasLocalVideo: false }),
      idleState(),
      baseDeps()
    );

    expect(selection.routeUsed).toBe('video');
    expect(selection.providerKey).toBe('qwen.1.qwen3.5-omni-plus');
  });

  test('keeps local video requests in multimodal pool', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-qwen-local-video' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification(),
      buildFeatures(metadata, { hasVideo: true, hasRemoteVideo: false, hasLocalVideo: true }),
      idleState(),
      baseDeps()
    );

    expect(selection.routeUsed).toBe('multimodal');
    expect(selection.providerKey).toBe('qwen.1.qwen3.5-plus');
  });

});
