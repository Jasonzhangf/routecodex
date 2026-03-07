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
          baseURL: 'https://portal.qwen.ai/v1',
          auth: { type: 'qwen-oauth' },
          models: {
            'qwen3.5-plus': { supportsStreaming: true },
            'qwen3-coder-plus': { supportsStreaming: true }
          }
        }
      },
      { configPath: '/tmp/provider/qwen/config.v2.json' }
    );

    expect(inspection.providerId).toBe('qwen');
    expect(inspection.catalogId).toBe('qwen');
    expect(inspection.providerType).toBe('openai');
    expect(inspection.authType).toBe('qwen-oauth');
    expect(inspection.defaultModel).toBe('qwen3-coder-plus');
    expect(inspection.models).toEqual(['qwen3-coder-plus', 'qwen3.5-plus']);
    expect(inspection.routeTargets.default).toBe('qwen.qwen3-coder-plus');
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

  it('builds routing hints for capability-driven pools and web search policy wiring', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'qwen',
        provider: {
          id: 'qwen',
          type: 'openai',
          baseURL: 'https://portal.qwen.ai/v1',
          auth: { type: 'qwen-oauth' },
          models: {
            'qwen3.5-plus': { supportsStreaming: true },
            'qwen3-coder-plus': { supportsStreaming: true }
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
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      thinking: [
        {
          id: 'thinking-primary',
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      tools: [
        {
          id: 'tools-primary',
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      coding: [
        {
          id: 'coding-primary',
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      longcontext: [
        {
          id: 'longcontext-primary',
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      multimodal: [
        {
          id: 'multimodal-primary',
          targets: ['qwen.qwen3-coder-plus']
        }
      ],
      web_search: [
        {
          id: 'web_search-primary',
          targets: ['qwen.qwen3.5-plus']
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
            'qwen3-coder-plus': { supportsStreaming: true }
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
                  targets: ['qwen.qwen3-coder-plus']
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
