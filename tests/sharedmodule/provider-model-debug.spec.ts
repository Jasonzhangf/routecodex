import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import type { VirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model debug: why PROVIDER_NOT_AVAILABLE', () => {
  it('should show provider registry state when iflow.kimi-k2.5 fails', async () => {
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

    // 检查 providerRegistry
    const providerKeys = engine['providerRegistry'].listProviderKeys('iflow');
    console.log('iflow providerKeys:', providerKeys);

    // 检查每个 key 的 profile
    providerKeys.forEach(key => {
      const profile = engine['providerRegistry'].get(key);
      console.log(`key=${key}, profile.modelId=${profile?.modelId}`);
    });

    // 尝试路由
    await expect(engine.route({
      model: 'iflow.kimi-k2.5',
      messages: [{ role: 'user', content: 'Hello' }]
    })).rejects.toThrow(/PROVIDER_NOT_AVAILABLE/);
  });
});
