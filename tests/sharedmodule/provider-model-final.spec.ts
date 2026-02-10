import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type { VirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model with initialize call', () => {
  it('should work with iflow provider.model after initialize', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            enabled: true,
            type: 'iflow',
            baseURL: 'https://apis.iflow.cn/v1',
            maxContextTokens: 256000,
            compatibilityProfile: 'chat:iflow',
            auth: {
              type: 'apikey',
              apiKey: 'TEST_KEY'
            },
            models: {
              'kimi-k2.5': { maxContextTokens: 256000 },
              'glm-4.7': {}
            }
          }
        },
        routing: {
          default: [
            {
              id: 'default-primary',
              priority: 200,
              mode: 'round-robin',
              targets: ['iflow.kimi-k2.5']
            }
          ]
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine(config);
    
    // 关键：必须调用 initialize！
    engine.initialize({
      routing: config.routing,
      providers: config.providers,
      classifier: { longContextThresholdTokens: 180000 },
      loadBalancing: { strategy: 'round-robin' },
      health: { failureThreshold: 3, cooldownMs: 30000 }
    });

    const providerKeys = engine['providerRegistry'].listProviderKeys('iflow');
    console.log('iflow providerKeys:', providerKeys);
    expect(providerKeys.length).toBeGreaterThan(0);

   const result = await engine.route({
     model: 'iflow.kimi-k2.5',
     messages: [{ role: 'user', content: 'Hello' }]
   });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/iflow/);
  });

  it('should fail when provider is disabled', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            enabled: false,
            type: 'iflow',
            baseURL: 'https://apis.iflow.cn/v1',
            maxContextTokens: 256000,
            compatibilityProfile: 'chat:iflow',
            auth: {
              type: 'apikey',
              apiKey: 'TEST_KEY'
            },
            models: {
              'kimi-k2.5': {}
            }
          }
        },
        routing: {
          default: [
            {
              id: 'default-primary',
              priority: 200,
              mode: 'round-robin',
              targets: ['iflow.kimi-kimi-k2.5']
            }
          ]
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine(config);
    engine.initialize(config);

    await expect(engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(/PROVIDER_NOT_AVAILABLE/);
  });

  it('should work with empty routing but provider.model exists', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          iflow: {
            id: 'iflow',
            enabled: true,
            type: 'iflow',
            baseURL: 'https://apis.iflow.cn/v1',
            maxContextTokens: 256000,
            compatibilityProfile: 'chat:iflow',
            auth: {
              type: 'apikey',
              apiKey: 'TEST_KEY'
            },
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
    engine.initialize(config);

    const result = await engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/iflow/);
  });
});
