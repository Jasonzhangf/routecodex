import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildBaseInput(): any {
  return {
    virtualrouter: {
      providers: {
        iflow: {
          id: 'iflow',
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
        default: ['iflow.kimi-k2'],
        web_search: [
          {
            id: 'web-search-primary',
            mode: 'priority',
            targets: ['iflow.kimi-k2', 'iflow.glm-4.7']
          }
        ]
      },
      webSearch: {
        engines: [
          {
            id: 'iflow:web_search',
            providerKey: 'iflow',
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
    expect(engines[0]?.providerKey).toBe('iflow.kimi-k2');
  });

  it('resolves aggregate provider+model key to alias-specific web_search target', () => {
    const input = buildBaseInput();
    input.virtualrouter.providers.iflow.auth = {
      type: 'apiKey',
      entries: [{ alias: 'key1', type: 'apiKey', value: 'TEST' }]
    };
    input.virtualrouter.routing.web_search[0].targets = ['iflow.key1.kimi-k2'];
    input.virtualrouter.webSearch.engines[0].providerKey = 'iflow.kimi-k2';

    const result = bootstrapVirtualRouterConfig(input);
    const engines = result.config.webSearch?.engines ?? [];
    expect(engines).toHaveLength(1);
    expect(engines[0]?.providerKey).toBe('iflow.key1.kimi-k2');
  });

  it('throws when providerKey cannot be resolved into routing.web_search targets', () => {
    const input = buildBaseInput();
    input.virtualrouter.webSearch.engines[0].providerKey = 'missing-provider';
    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(VirtualRouterError);
    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(/websearch engine/i);
  });
});
