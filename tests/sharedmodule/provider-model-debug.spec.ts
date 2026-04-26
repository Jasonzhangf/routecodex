import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type { VirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model debug: why PROVIDER_NOT_AVAILABLE', () => {
  it('should show provider registry state when glm.kimi-k2.5 fails', async () => {
    const input: VirtualRouterConfig = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            enabled: true,
            type: 'glm',
            baseURL: 'https://api.glm.com/v1',
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
    const engine = new VirtualRouterEngine(config);

    // 检查 providerRegistry
    const providerKeys = engine['providerRegistry'].listProviderKeys('glm');
    console.log('glm providerKeys:', providerKeys);

    // 检查每个 key 的 profile
    providerKeys.forEach(key => {
      const profile = engine['providerRegistry'].get(key);
      console.log(`key=${key}, profile.modelId=${profile?.modelId}`);
    });

    // 尝试路由
    await expect(engine.route({
      model: 'glm.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(/PROVIDER_NOT_AVAILABLE/);
  });
});
