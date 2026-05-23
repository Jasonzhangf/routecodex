import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

describe('provider.model direct access without routing', () => {
  it('expands provider.model routing target through all auth entries without hand-written key aliases', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          windsurf: {
            id: 'windsurf',
            type: 'openai',
            enabled: true,
            endpoint: 'https://example.invalid',
            auth: {
              type: 'windsurf-account',
              entries: [
                { alias: 'ws-pro-1', type: 'windsurf-account', account: 'a@example.invalid', password: 'p1' },
                { alias: 'ws-pro-2', type: 'windsurf-account', account: 'b@example.invalid', password: 'p2' },
                { alias: 'ws-pro-3', type: 'windsurf-account', account: 'c@example.invalid', password: 'p3' },
                { alias: 'ws-pro-4', type: 'windsurf-account', account: 'd@example.invalid', password: 'p4' },
                { alias: 'ws-pro-5', type: 'windsurf-account', account: 'e@example.invalid', password: 'p5' }
              ]
            },
            models: {
              'gpt-5.4-none': {}
            }
          }
        },
        routing: {
          thinking: [
            {
              id: 'gateway-priority-5520-thinking',
              mode: 'priority',
              targets: ['windsurf.gpt-5.4-none']
            }
          ]
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);

    expect(config.config.routing.thinking[0].targets).toEqual([
      'windsurf.ws-pro-1.gpt-5.4-none',
      'windsurf.ws-pro-2.gpt-5.4-none',
      'windsurf.ws-pro-3.gpt-5.4-none',
      'windsurf.ws-pro-4.gpt-5.4-none',
      'windsurf.ws-pro-5.gpt-5.4-none'
    ]);
    expect(Object.keys(config.runtime).sort()).toEqual([
      'windsurf.ws-pro-1',
      'windsurf.ws-pro-2',
      'windsurf.ws-pro-3',
      'windsurf.ws-pro-4',
      'windsurf.ws-pro-5'
    ]);
    expect(config.targetRuntime['windsurf.ws-pro-5.gpt-5.4-none']).toMatchObject({
      runtimeKey: 'windsurf.ws-pro-5',
      keyAlias: 'ws-pro-5'
    });
  });

  it('should route directly to provider.model when specified in request', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            type: 'glm',
            enabled: true,
            endpoint: 'https://apis.glm.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'kimi-k2.5': { maxContextTokens: 262144 },
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
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    const result = await engine.route(
      {
        model: 'glm.kimi-k2.5',
        messages: [{ role: 'user', content: 'Hello' }]
      },
      {}
    );

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });

  it('should return PROVIDER_NOT_AVAILABLE when provider is disabled', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            type: 'glm',
            enabled: false,
            endpoint: 'https://apis.glm.cn/v1',
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
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    expect(() => engine.route(
      {
        model: 'glm.kimi-k2.5',
        messages: [{ role: 'user', content: 'Hello' }]
      },
      {}
    )).toThrow(/PROVIDER_NOT_AVAILABLE|All providers unavailable/);
  });

  it('should work when provider.model is also in routing targets', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            type: 'glm',
            enabled: true,
            endpoint: 'https://apis.glm.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
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

    const result = await engine.route(
      {
        model: 'glm.kimi-k2.5',
        messages: [{ role: 'user', content: 'Hello' }]
      },
      {}
    );

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });

  it('should work even when routing section is omitted', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          glm: {
            id: 'glm',
            type: 'glm',
            enabled: true,
            endpoint: 'https://apis.glm.cn/v1',
            auth: { type: 'apikey', apiKey: 'TEST_KEY' },
            models: {
              'kimi-k2.5': {}
            }
          }
        }
      }
    };

    const config = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config.config);

    const result = await engine.route(
      {
        model: 'glm.kimi-k2.5',
        messages: [{ role: 'user', content: 'Hello' }]
      },
      {}
    );

    expect(result).toBeDefined();
    expect(result.target?.providerKey).toMatch(/glm/);
  });
});
