import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';

describe('bootstrapVirtualRouterConfig loadBalancing-only route targets', () => {
  function buildInput(routingEntry: Record<string, unknown>): any {
    return {
      virtualrouter: {
        providers: {
          openai: {
            id: 'openai',
            type: 'openai',
            endpoint: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'TEST' },
            models: {
              'gpt-5.2': {},
              'gpt-4.1': {}
            }
          }
        },
        routing: {
          default: [routingEntry]
        }
      }
    };
  }

  it('derives targets from loadBalancing.order without duplicating top-level targets', () => {
    const result = bootstrapVirtualRouterConfig(
      buildInput({
        id: 'default-primary',
        loadBalancing: {
          order: ['openai.gpt-5.2', 'openai.gpt-4.1']
        }
      })
    );

    expect(result.config.routing.default?.[0]?.targets).toEqual([
      'openai.key1.gpt-5.2',
      'openai.key1.gpt-4.1'
    ]);
    expect(result.config.routing.default?.[0]?.mode).toBe('priority');
  });

  it('falls back to loadBalancing.weights key order when top-level targets are omitted', () => {
    const result = bootstrapVirtualRouterConfig(
      buildInput({
        id: 'default-primary',
        loadBalancing: {
          weights: {
            'openai.gpt-4.1': 9,
            'openai.gpt-5.2': 1
          }
        }
      })
    );

    expect(result.config.routing.default?.[0]?.targets).toEqual([
      'openai.key1.gpt-4.1',
      'openai.key1.gpt-5.2'
    ]);
    expect(result.config.routing.default?.[0]?.mode).toBe('priority');
  });
});
