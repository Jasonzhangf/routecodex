import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildBaseInput(): any {
  return {
    virtualrouter: {
      providers: {
        glm: {
          id: 'glm',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: { type: 'apikey', apiKey: 'TEST' },
          models: {
            'kimi-k2': {},
            'glm-4.7': {}
          }
        }
      },
      routing: {
        default: ['glm.kimi-k2'],
        web_search: [
          {
            id: 'web-search-primary',
            mode: 'priority',
            targets: ['glm.kimi-k2', 'glm.glm-4.7']
          }
        ]
      },
      webSearch: {
        engines: [
          {
            id: 'glm:web_search',
            providerKey: 'glm',
            default: true
          }
        ]
      }
    }
  };
}

describe('bootstrapVirtualRouterConfig webSearch providerKey resolution', () => {
  it('resolves model-less providerKey to first routing.web_search target', () => {
    const input = buildBaseInput();
    const result = bootstrapVirtualRouterConfig(input);
    const engines = result.config.webSearch?.engines ?? [];
    expect(engines).toHaveLength(1);
    expect(engines[0]?.providerKey).toBe('glm.kimi-k2');
  });

  it('resolves aggregate provider+model key to alias-specific web_search target', () => {
    const input = buildBaseInput();
    input.virtualrouter.providers.glm.auth = {
      type: 'apiKey',
      entries: [{ alias: 'key1', type: 'apiKey', value: 'TEST' }]
    };
    input.virtualrouter.routing.web_search[0].targets = ['glm.key1.kimi-k2'];
    input.virtualrouter.webSearch.engines[0].providerKey = 'glm.kimi-k2';

    const result = bootstrapVirtualRouterConfig(input);
    const engines = result.config.webSearch?.engines ?? [];
    expect(engines).toHaveLength(1);
    expect(engines[0]?.providerKey).toBe('glm.key1.kimi-k2');
  });

  it('throws when providerKey cannot be resolved into routing.web_search targets', () => {
    const input = buildBaseInput();
    input.virtualrouter.webSearch.engines[0].providerKey = 'missing-provider';
    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(VirtualRouterError);
    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(/websearch engine/i);
  });
});
