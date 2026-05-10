import { describe, expect, test } from '@jest/globals';

import { buildRouteCandidates } from '../../src/router/virtual-router/engine-selection/route-utils.js';
import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import type { RoutePoolTier, RoutingFeatures } from '../../src/router/virtual-router/types.js';

describe('virtual-router web_search preview route priority', () => {
  test('prepends web_search route when web_search_preview tool is declared', () => {
    const routing: Record<string, RoutePoolTier[]> = {
      default: [{ id: 'default-primary', priority: 100, mode: 'priority', targets: ['deepseek-web.deepseek-chat'] }],
      tools: [{ id: 'tools-primary', priority: 100, mode: 'priority', targets: ['deepseek-web.deepseek-v4-flash'] }],
      web_search: [{ id: 'web-search-primary', priority: 100, mode: 'priority', targets: ['deepseek-web.deepseek-v4-flash-search'] }]
    };
    const registry = new ProviderRegistry({
      'deepseek-web.deepseek-chat': {
        providerKey: 'deepseek-web.deepseek-chat',
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'TEST' },
        outboundProfile: 'openai-chat',
        modelId: 'deepseek-chat'
      } as any,
      'deepseek-web.deepseek-v4-flash': {
        providerKey: 'deepseek-web.deepseek-v4-flash',
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'TEST' },
        outboundProfile: 'openai-chat',
        modelId: 'deepseek-v4-flash'
      } as any,
      'deepseek-web.deepseek-v4-flash-search': {
        providerKey: 'deepseek-web.deepseek-v4-flash-search',
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'TEST' },
        outboundProfile: 'openai-chat',
        modelId: 'deepseek-v4-flash-search',
        capabilities: ['web_search']
      } as any
    });

    const features: RoutingFeatures = {
      requestId: 'req-web-search-preview',
      model: 'gpt-4.1',
      totalMessages: 1,
      userTextSample: '搜索今天的公开网页信息',
      toolCount: 1,
      hasTools: true,
      hasToolCallResponses: false,
      hasVisionTool: false,
      hasImageAttachment: false,
      hasWebTool: true,
      hasWebSearchToolDeclared: true,
      hasCodingTool: false,
      hasThinkingKeyword: false,
      estimatedTokens: 64,
      latestMessageFromUser: true,
      metadata: { requestId: 'req-web-search-preview' }
    };

    const candidates = buildRouteCandidates(
      'thinking',
      ['thinking', 'default'],
      features,
      routing,
      registry
    );

    expect(candidates[0]).toBe('web_search');
    expect(candidates).toContain('tools');
  });
});
