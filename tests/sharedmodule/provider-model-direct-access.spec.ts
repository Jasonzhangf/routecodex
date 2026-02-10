import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model direct access without routing', () => {
  it('should route directly to provider.model when specified in request', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            type: 'iflow',
            enabled: true,
            endpoint: 'https://apis.iflow.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'kimi-k2.5': { maxContextTokens: 256000 },
              'glm-4.7': {}
            }
          }
        },
        routing: {
          default: []
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine(config);

    const result = await engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/iflow/);
  });

  it('should return PROVIDER_NOT_AVAILABLE when provider is disabled', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            type: 'iflow',
            enabled: false,
            endpoint: 'https://apis.iflow.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'kimi-k2.5': {}
            }
          }
        },
        routing: {
          default: []
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine(config);

    await expect(engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(/PROVIDER_NOT_AVAILABLE|All providers unavailable/);
  });

  it('should work when provider.model is also in routing targets', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            type: 'iflow',
            enabled: true,
            endpoint: 'https://apis.iflow.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'kimi-k2.5': {}
            }
          }
        },
        routing: {
          default: ['iflow.kimi-k2.5']
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine(config);

    const result = await engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/iflow/);
  });
});
