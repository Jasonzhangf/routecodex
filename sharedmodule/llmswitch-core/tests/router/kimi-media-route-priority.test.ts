import { describe, expect, test } from '@jest/globals';

import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import { buildRouteCandidates } from '../../src/router/virtual-router/engine-selection/route-utils.js';

describe('virtual-router multimodal route priority', () => {
  const providerRegistry = new ProviderRegistry({
    'iflow.1-186.kimi-k2.5': {
      providerKey: 'iflow.1-186.kimi-k2.5',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'kimi-k2.5'
    },
    'iflow.1-186.qwen3-vl-plus': {
      providerKey: 'iflow.1-186.qwen3-vl-plus',
      providerType: 'openai',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-chat',
      modelId: 'qwen3-vl-plus'
    },
    'tab.key1.gpt-5.2-codex': {
      providerKey: 'tab.key1.gpt-5.2-codex',
      providerType: 'responses',
      endpoint: 'https://example.com',
      auth: { type: 'apikey', value: 'x' },
      outboundProfile: 'openai-responses',
      modelId: 'gpt-5.2-codex'
    }
  });

  const routing = {
    multimodal: [
      {
        id: 'multimodal-primary',
        priority: 200,
        mode: 'priority',
        targets: ['iflow.1-186.kimi-k2.5']
      },
      {
        id: 'multimodal-backup',
        priority: 100,
        mode: 'priority',
        backup: true,
        targets: ['tab.key1.gpt-5.2-codex']
      }
    ],
    vision: [
      {
        id: 'vision-primary',
        priority: 100,
        mode: 'priority',
        targets: ['iflow.1-186.qwen3-vl-plus'],
        force: true
      }
    ],
    coding: [
      {
        id: 'coding-primary',
        priority: 100,
        mode: 'priority',
        targets: ['iflow.1-186.kimi-k2.5']
      }
    ],
    default: [
      {
        id: 'default-primary',
        priority: 100,
        mode: 'priority',
        targets: ['tab.key1.gpt-5.2-codex']
      }
    ]
  };

  test('prefers multimodal route for media requests', () => {
    const candidates = buildRouteCandidates(
      'multimodal',
      ['multimodal'],
      {
        requestId: 'req_media',
        model: 'gpt-test',
        totalMessages: 1,
        userTextSample: 'see attachment',
        toolCount: 0,
        hasTools: false,
        hasToolCallResponses: false,
        hasVisionTool: false,
        hasImageAttachment: true,
        hasWebTool: false,
        hasCodingTool: false,
        hasThinkingKeyword: false,
        estimatedTokens: 100,
        latestMessageFromUser: true,
        metadata: { requestId: 'req_media' }
      },
      routing,
      providerRegistry
    );

    expect(candidates[0]).toBe('multimodal');
    expect(candidates).not.toContain('vision');
  });

  test('falls back to vision when multimodal route is missing', () => {
    const routingWithoutMultimodal = {
      vision: routing.vision,
      coding: routing.coding,
      default: routing.default
    };

    const candidates = buildRouteCandidates(
      'multimodal',
      ['multimodal'],
      {
        requestId: 'req_media_fallback',
        model: 'gpt-test',
        totalMessages: 1,
        userTextSample: 'see attachment',
        toolCount: 0,
        hasTools: false,
        hasToolCallResponses: false,
        hasVisionTool: false,
        hasImageAttachment: true,
        hasWebTool: false,
        hasCodingTool: false,
        hasThinkingKeyword: false,
        estimatedTokens: 100,
        latestMessageFromUser: true,
        metadata: { requestId: 'req_media_fallback' }
      },
      routingWithoutMultimodal,
      providerRegistry
    );

    expect(candidates[0]).toBe('vision');
  });

  test('keeps original route order without media', () => {
    const candidates = buildRouteCandidates(
      'multimodal',
      ['multimodal'],
      {
        requestId: 'req_text',
        model: 'gpt-test',
        totalMessages: 1,
        userTextSample: 'hello',
        toolCount: 0,
        hasTools: false,
        hasToolCallResponses: false,
        hasVisionTool: false,
        hasImageAttachment: false,
        hasWebTool: false,
        hasCodingTool: false,
        hasThinkingKeyword: false,
        estimatedTokens: 10,
        latestMessageFromUser: true,
        metadata: { requestId: 'req_text' }
      },
      routing,
      providerRegistry
    );

    expect(candidates[0]).toBe('multimodal');
  });

  test('uses iflow kimi target first inside multimodal priority pool', () => {
    const selectionTargets = selectTargetsForRoute(routing.multimodal);
    expect(selectionTargets[0]).toBe('iflow.1-186.kimi-k2.5');
    expect(selectionTargets).toContain('tab.key1.gpt-5.2-codex');
  });
});

function selectTargetsForRoute(routeTiers: Array<{ targets: string[]; priority?: number; backup?: boolean }>): string[] {
  return [...routeTiers]
    .sort((a, b) => {
      if (a.backup && !b.backup) return 1;
      if (!a.backup && b.backup) return -1;
      return (b.priority ?? 0) - (a.priority ?? 0);
    })
    .flatMap((tier) => tier.targets);
}
