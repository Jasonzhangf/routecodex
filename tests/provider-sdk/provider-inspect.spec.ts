import { describe, expect, it } from '@jest/globals';

import { buildRoutingHintsConfigFragment, inspectProviderConfig } from '../../src/provider-sdk/provider-inspect.js';

describe('provider inspect', () => {
  it('merges config facts with catalog metadata and route targets', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'qwen',
        provider: {
          id: 'qwen',
          type: 'openai',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          auth: { type: 'qwen-oauth' },
          models: {
            'qwen3.5-plus': { supportsStreaming: true },
            'coder-model': { supportsStreaming: true }
          }
        }
      },
      { configPath: '/tmp/provider/qwen/config.v2.json' }
    );

    expect(inspection.providerId).toBe('qwen');
    expect(inspection.catalogId).toBe('qwen');
    expect(inspection.providerType).toBe('openai');
    expect(inspection.authType).toBe('qwen-oauth');
    expect(inspection.defaultModel).toBe('coder-model');
    expect(inspection.models).toEqual(['coder-model', 'qwen3.5-plus']);
    expect(inspection.routeTargets.default).toBe('qwen.coder-model');
    expect(inspection.routeTargets.webSearch).toBe('qwen.qwen3.5-plus');
    expect(inspection.webSearch).toMatchObject({
      engineId: 'qwen:web_search',
      routeTarget: 'qwen.qwen3.5-plus',
      executionMode: 'servertool'
    });
    expect(inspection.capabilities).toMatchObject({
      supportsCoding: true,
      supportsLongContext: true,
      supportsMultimodal: true,
      supportsTools: true
    });
    expect(inspection.configPath).toBe('/tmp/provider/qwen/config.v2.json');
  });

  it('infers deepseek-web multimodal + web_search routing from config aliases/capabilities', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'deepseek-web',
        provider: {
          id: 'deepseek-web',
          type: 'openai',
          baseURL: 'https://chat.deepseek.com',
          compatibilityProfile: 'chat:deepseek-web',
          auth: { type: 'deepseek-account' },
          models: {
            'deepseek-chat': {
              supportsStreaming: true,
              capabilities: ['web_search', 'multimodal'],
              aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-search', 'deepseek-v4-vision']
            },
            'deepseek-reasoner': {
              supportsStreaming: true,
              capabilities: ['web_search', 'multimodal'],
              aliases: ['deepseek-v4-pro', 'deepseek-v4-pro-search']
            }
          }
        }
      } as any,
      { includeRoutingHints: true }
    );

    expect(inspection.routeTargets.default).toBe('deepseek-web.deepseek-chat');
    expect(inspection.routeTargets.webSearch).toBe('deepseek-web.deepseek-v4-flash-search');
    expect(inspection.routeTargets.multimodal).toBe('deepseek-web.deepseek-v4-vision');
    expect(inspection.webSearch).toMatchObject({
      engineId: 'deepseek:web_search',
      routeTarget: 'deepseek-web.deepseek-v4-flash-search',
      providerKey: 'deepseek-web.deepseek-v4-flash-search',
      modelId: 'deepseek-v4-flash-search',
      executionMode: 'direct'
    });
    expect(inspection.capabilities).toMatchObject({
      supportsMultimodal: true,
      supportsTools: true,
      supportsReasoning: true
    });
    expect(inspection.routingHints?.routing).toMatchObject({
      multimodal: [
        {
          id: 'multimodal-primary',
          loadBalancing: {
            weights: { 'deepseek-web.deepseek-v4-vision': 1 }
          }
        }
      ],
      web_search: [
        {
          id: 'web_search-primary',
          loadBalancing: {
            weights: { 'deepseek-web.deepseek-v4-flash-search': 1 }
          }
        }
      ]
    });
  });

  it('builds routing hints for capability-driven pools and web search policy wiring', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'qwen',
        provider: {
          id: 'qwen',
          type: 'openai',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          auth: { type: 'qwen-oauth' },
          models: {
            'qwen3.5-plus': { supportsStreaming: true },
            'coder-model': { supportsStreaming: true }
          }
        }
      },
      { includeRoutingHints: true }
    );

    expect(inspection.routingHints).toBeTruthy();
    expect(inspection.routingHints?.routing).toMatchObject({
      default: [
        {
          id: 'default-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      thinking: [
        {
          id: 'thinking-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      tools: [
        {
          id: 'tools-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      coding: [
        {
          id: 'coding-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      longcontext: [
        {
          id: 'longcontext-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      multimodal: [
        {
          id: 'multimodal-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.coder-model': 1 }
          }
        }
      ],
      web_search: [
        {
          id: 'web_search-primary',
          loadBalancing: {
            strategy: 'weighted',
            weights: { 'qwen.qwen3.5-plus': 1 }
          }
        }
      ]
    });
    expect(inspection.routingHints?.policyOptions).toMatchObject({
      webSearch: {
        engines: [
          {
            id: 'qwen:web_search',
            providerKey: 'qwen.qwen3.5-plus'
          }
        ],
        search: {
          'qwen:web_search': {
            providerKey: 'qwen.qwen3.5-plus'
          }
        }
      }
    });
  });

  it('builds a paste-ready config fragment from routing hints', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'qwen',
        provider: {
          id: 'qwen',
          type: 'openai',
          models: {
            'qwen3.5-plus': { supportsStreaming: true },
            'coder-model': { supportsStreaming: true }
          }
        }
      },
      { includeRoutingHints: true }
    );

    const fragment = buildRoutingHintsConfigFragment(inspection.routingHints!);
    expect(fragment).toMatchObject({
      virtualrouter: {
        activeRoutingPolicyGroup: 'default',
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                {
                  id: 'default-primary',
                  loadBalancing: {
                    strategy: 'weighted',
                    weights: { 'qwen.coder-model': 1 }
                  }
                }
              ]
            },
            webSearch: {
              engines: [
                {
                  id: 'qwen:web_search'
                }
              ]
            }
          }
        }
      }
    });
  });

  it('uses provider config metadata first for custom standard providers', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'custom-openai',
        provider: {
          id: 'custom-openai',
          type: 'openai',
          defaultModel: 'my-model',
          sdkBinding: { family: 'openai-compatible', supported: true },
          capabilities: {
            supportsTools: true,
            supportsLongContext: true
          },
          webSearch: {
            engineId: 'custom:web_search',
            executionMode: 'direct',
            modelId: 'search-model'
          },
          models: {
            'my-model': { supportsStreaming: true },
            'search-model': { supportsStreaming: true }
          }
        }
      },
      { includeRoutingHints: true }
    );

    expect(inspection.catalogId).toBeUndefined();
    expect(inspection.sdkBinding).toMatchObject({ family: 'openai-compatible', supported: true });
    expect(inspection.defaultModel).toBe('my-model');
    expect(inspection.routeTargets.default).toBe('custom-openai.my-model');
    expect(inspection.routeTargets.webSearch).toBe('custom-openai.search-model');
    expect(inspection.webSearch).toMatchObject({
      engineId: 'custom:web_search',
      providerKey: 'custom-openai.search-model',
      executionMode: 'direct'
    });
    expect(inspection.routingHints?.policyOptions).toMatchObject({
      webSearch: {
        search: {
          'custom:web_search': {
            providerKey: 'custom-openai.search-model'
          }
        }
      }
    });
  });
});
