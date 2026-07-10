import { bootstrapVirtualRouterConfig, type VirtualRouterConfig } from './helpers/virtual-router-bootstrap-direct-native.js';
import { VirtualRouterEngine } from './helpers/virtual-router-engine-direct-native.js';

describe('provider.model with initialize call', () => {
  it('should work with glm provider.model after initialize', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            enabled: true,
            type: 'glm',
            baseURL: 'https://apis.glm.cn/v1',
            maxContextTokens: 262144,
            compatibilityProfile: 'chat:glm',
            auth: {
              type: 'apikey',
              apiKey: 'TEST_KEY'
            },
            models: {
              'kimi-k2.5': { maxContextTokens: 262144 },
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
              targets: ['glm.kimi-k2.5']
            }
          ]
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    const providerKeys = Object.keys(config.config.providers).filter((key) => key.startsWith('glm.'));
    expect(providerKeys.length).toBeGreaterThan(0);

   const result = await engine.route({
     model: 'glm.kimi-k2.5',
     messages: [{ role: 'user', content: 'Hello' }]
   });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });

  it('should fail when provider is disabled', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            enabled: false,
            type: 'glm',
            baseURL: 'https://apis.glm.cn/v1',
            maxContextTokens: 262144,
            compatibilityProfile: 'chat:glm',
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
              targets: ['glm.kimi-k2.5']
            }
          ]
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    expect(() => engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).toThrow(/All providers unavailable for model glm\.kimi-k2\.5/);
  });

  it('should work with empty routing but provider.model exists', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            enabled: true,
            type: 'glm',
            baseURL: 'https://apis.glm.cn/v1',
            maxContextTokens: 262144,
            compatibilityProfile: 'chat:glm',
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
          default: ['glm.kimi-k2.5']
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    const result = await engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });
});
