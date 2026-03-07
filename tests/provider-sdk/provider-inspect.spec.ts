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

  it('falls back to configured defaults for custom providers without catalog metadata', () => {
    const inspection = inspectProviderConfig({
      version: '2.0.0',
      providerId: 'custom-local',
      provider: {
        id: 'custom-local',
        type: 'openai',
        defaultModel: 'my-model',
        models: {
          'my-model': { supportsStreaming: true }
        }
      }
    });

    expect(inspection.catalogId).toBeUndefined();
    expect(inspection.sdkBinding).toBeUndefined();
    expect(inspection.defaultModel).toBe('my-model');
    expect(inspection.routeTargets.default).toBe('custom-local.my-model');
    expect(inspection.webSearch).toBeUndefined();
  });
});
