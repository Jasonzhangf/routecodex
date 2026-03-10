import { describe, expect, test } from '@jest/globals';

import { ContextAdvisor } from '../../src/router/virtual-router/context-advisor.js';
import { selectProviderImpl } from '../../src/router/virtual-router/engine/routing-pools/index.js';
import { ProviderHealthManager } from '../../src/router/virtual-router/health-manager.js';
import { RouteLoadBalancer } from '../../src/router/virtual-router/load-balancer.js';
import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import { VirtualRouterEngine } from '../../src/router/virtual-router/engine.js';
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
      modelId: 'qwen3.5-plus'
    } as any,
    'qwen.1.qwen3-vl-plus': {
      providerKey: 'qwen.1.qwen3-vl-plus',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apiKey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'qwen3-vl-plus'
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
    vision: [
      {
        id: 'vision-primary',
        priority: 100,
        mode: 'priority',
        targets: ['qwen.1.qwen3-vl-plus']
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

  test('routes remote video requests to qwen3.5-plus in multimodal pool', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-qwen-remote-video' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification(),
      buildFeatures(metadata, { hasVideo: true, hasRemoteVideo: true, hasLocalVideo: false }),
      idleState(),
      baseDeps()
    );

    expect(selection.routeUsed).toBe('multimodal');
    expect(selection.providerKey).toBe('qwen.1.qwen3.5-plus');
  });

  test('falls back to vision pool for local video requests', () => {
    const metadata: RouterMetadataInput = { requestId: 'req-qwen-local-video' };
    const selection = selectProviderImpl(
      'multimodal',
      metadata,
      buildClassification(),
      buildFeatures(metadata, { hasVideo: true, hasRemoteVideo: false, hasLocalVideo: true }),
      idleState(),
      baseDeps()
    );

    expect(selection.routeUsed).toBe('vision');
    expect(selection.providerKey).toBe('qwen.1.qwen3-vl-plus');
  });

  test('falls back from direct qwen.qwen3.5-plus to vision route on local video', () => {
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize({
      routing,
      providers: {
        'qwen.1.qwen3.5-plus': {
          providerKey: 'qwen.1.qwen3.5-plus',
          providerType: 'openai',
          endpoint: 'https://example.com',
          auth: { type: 'apiKey', value: 'x' },
          outboundProfile: 'openai-chat',
          modelId: 'qwen3.5-plus'
        },
        'qwen.1.qwen3-vl-plus': {
          providerKey: 'qwen.1.qwen3-vl-plus',
          providerType: 'openai',
          endpoint: 'https://example.com',
          auth: { type: 'apiKey', value: 'x' },
          outboundProfile: 'openai-chat',
          modelId: 'qwen3-vl-plus'
        }
      },
      classifier: {},
      loadBalancing: {}
    } as any);

    const request = {
      model: 'qwen.qwen3.5-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this video' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }
          ]
        }
      ],
      tools: []
    } as any;
    const result = engine.route(request, { requestId: 'req-direct-local-video' } as any);
    expect(result.decision.routeName).toBe('vision');
    expect(result.target.providerKey).toBe('qwen.1.qwen3-vl-plus');
  });
});
