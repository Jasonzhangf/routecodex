import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type { VirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model with real config structure', () => {
  it('should work with glm provider.model when routing.default has targets', async () => {
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
              type: 'glm-oauth',
              entries: [
                {
                  alias: '1-186',
                  type: 'glm-oauth',
                  tokenFile: '~/.routecodex/auth/glm-oauth-1-186.json'
                },
                {
                  alias: '3-138',
                  type: 'glm-oauth',
                  tokenFile: '~/.routecodex/auth/glm-oauth-3-138.json'
                }
              ]
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
    const engine = new VirtualRouterEngine(config);

    const result = await engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });

  it('should fail when provider is disabled even if in routing', async () => {
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
    const engine = new VirtualRouterEngine(config);

    await expect(engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(/PROVIDER_NOT_AVAILABLE/);
  });

  it('should work with apikey auth instead of oauth', async () => {
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
              apiKey: 'TEST_API_KEY'
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
    const engine = new VirtualRouterEngine(config);

    const result = await engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    });

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });
});
