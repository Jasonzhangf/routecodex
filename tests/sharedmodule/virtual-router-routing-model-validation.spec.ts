import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('bootstrapVirtualRouterConfig routing model validation', () => {
  it('throws when routing references an unknown model for a provider with declared models', () => {
    const input: any = {
      virtualrouter: {
        providers: {
          openai: {
            id: 'openai',
            type: 'openai',
            endpoint: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'TEST' },
            models: {
              'gpt-5.2': {}
            }
          }
        },
        routing: {
          default: ['openai.gpt-unknown']
        }
      }
    };

    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(VirtualRouterError);
    expect(() => bootstrapVirtualRouterConfig(input)).toThrow(/unknown model/i);
  });

  it('does not throw when provider has no models registry (backward compatible)', () => {
    const input: any = {
      virtualrouter: {
        providers: {
          openai: {
            id: 'openai',
            type: 'openai',
            endpoint: 'https://example.invalid',
            auth: { type: 'apikey', apiKey: 'TEST' }
          }
        },
        routing: {
          default: ['openai.gpt-any']
        }
      }
    };

    expect(() => bootstrapVirtualRouterConfig(input)).not.toThrow();
  });
});

