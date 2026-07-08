import { describe, expect, it } from '@jest/globals';

import { buildRoutingHintsConfigFragment, inspectProviderConfig } from '../../src/provider-sdk/provider-inspect.js';

describe('provider inspect', () => {
  it('inspects custom OpenAI-compatible providers without removed catalog wiring', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'custom-coder',
        provider: {
          id: 'custom-coder',
          type: 'openai',
          baseURL: 'https://api.example.com/v1',
          auth: { type: 'apikey' },
          models: {
            'coder-model': { supportsStreaming: true }
          }
        }
      },
      { configPath: '/tmp/provider/custom-coder/config.v2.json' }
    );

    expect(inspection.providerId).toBe('custom-coder');
    expect(inspection.catalogId).toBeUndefined();
    expect(inspection.providerType).toBe('openai');
    expect(inspection.authType).toBe('apikey');
    expect(inspection.defaultModel).toBe('coder-model');
    expect(inspection.models).toEqual(['coder-model']);
    expect(inspection.routeTargets.default).toBe('custom-coder.coder-model');
    expect(inspection.routeTargets.webSearch).toBeUndefined();
    expect(inspection.webSearch).toBeUndefined();
    expect(inspection.capabilities).toMatchObject({ supportsCoding: true, supportsTools: true });
    expect(inspection.configPath).toBe('/tmp/provider/custom-coder/config.v2.json');
  });

  it('builds a paste-ready config fragment from routing hints', () => {
    const inspection = inspectProviderConfig(
      {
        version: '2.0.0',
        providerId: 'custom-search',
        provider: {
          id: 'custom-search',
          type: 'openai',
          auth: { type: 'apikey' },
          models: {
            'search-model': {
              supportsStreaming: true,
              capabilities: ['web_search']
            }
          },
          webSearch: {
            engineId: 'custom:web_search',
            executionMode: 'direct',
            modelId: 'search-model'
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
                  id: 'default-primary'
                }
              ]
            },
            webSearch: {
              engines: [
                {
                  id: 'custom:web_search'
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
