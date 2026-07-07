import { compileRouteCodexRuntimeManifestSync } from '../../src/modules/llmswitch/bridge/routing-integrations.js';
import { compileRouteCodexRuntimeConfigManifest } from '../../src/config/user-config-loader.js';

describe('Rust runtime config materialization', () => {
  function providerConfig(providerId: string, provider: Record<string, unknown>): Record<string, unknown> {
    return {
      version: '2.0.0',
      providerId,
      provider: {
        id: providerId,
        ...provider
      }
    };
  }

  it('compiles deterministic VR and pipeline runtime manifest from decoded config records', () => {
    const userConfig = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      servertool: {
        apply_patch: { mode: 'freeform', allow: ['apply_patch'] }
      },
      httpserver: {
        ports: [
          { port: 5520, mode: 'router', routingPolicyGroup: 'beta' },
          { port: 7001, mode: 'provider', providerBinding: 'side.key1.side-model' }
        ]
      },
      virtualrouter: {
        forwarders: {
          'fwd.gpt.gpt-5.5': {
            protocol: 'openai',
            model: 'gpt-5.5',
            strategy: 'weighted',
            targets: [{ providerId: 'freepool', weight: 3 }]
          }
        },
        routingPolicyGroups: {
          alpha: {
            routing: {
              default: [{ id: 'alpha-route', targets: ['unused.alpha-model'] }]
            }
          },
          beta: {
            hitLog: { enabled: true, omit: ['headers'] },
            routing: {
              default: [{ id: 'beta-route', target: 'fwd.gpt.gpt-5.5' }]
            }
          }
        }
      }
    };
    const providerConfigs = {
      freepool: providerConfig('freepool', {
        type: 'openai',
        auth: {
          entries: [
            { alias: 'key1', apiKey: 'test-key-1' },
            { alias: 'key2', apiKey: 'test-key-2' }
          ]
        },
        models: {
          'gpt-5.5': { capabilities: ['text', 'thinking'] }
        }
      }),
      side: providerConfig('side', {
        type: 'openai',
        auth: { entries: [{ alias: 'key1', apiKey: 'side-key' }] },
        models: {
          'side-model': { capabilities: ['text'] }
        }
      }),
      unused: providerConfig('unused', {
        type: 'openai',
        auth: { entries: [{ alias: 'key1', apiKey: 'unused-key' }] },
        models: {
          'alpha-model': { capabilities: ['text'] }
        }
      })
    };

    const manifest = compileRouteCodexRuntimeManifestSync({
      userConfig,
      providerConfigs,
      options: { routingPolicyGroup: 'beta' }
    });
    const repeated = compileRouteCodexRuntimeManifestSync({
      userConfig,
      providerConfigs,
      options: { routingPolicyGroup: 'beta' }
    });

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(manifest));
    expect(manifest.manifestVersion).toBe('routecodex.runtime-config.v1');
    expect(manifest.routingPolicyGroup).toBe('beta');
    expect(Object.keys(manifest.virtualRouterBootstrapInput.providers).sort()).toEqual(['freepool', 'side']);
    expect(manifest.virtualRouterBootstrapInput.providers).not.toHaveProperty('unused');
    expect(manifest.virtualRouterBootstrapInput.routing.default).toEqual([
      expect.objectContaining({
        id: 'beta-route',
        target: 'fwd.gpt.gpt-5.5',
        routeParams: { routePolicyGroup: 'beta' }
      })
    ]);
    expect(manifest.virtualRouterBootstrapInput.forwarders?.['fwd.gpt.gpt-5.5']).toEqual(
      expect.objectContaining({
        forwarderId: 'fwd.gpt.gpt-5.5',
        modelId: 'gpt-5.5',
        targets: [
          expect.objectContaining({ providerId: 'freepool', providerKey: 'freepool.key1.gpt-5.5', weight: 3 }),
          expect.objectContaining({ providerId: 'freepool', providerKey: 'freepool.key2.gpt-5.5', weight: 3 })
        ]
      })
    );
    expect(manifest.virtualRouterBootstrapInput.applyPatch).toEqual({ mode: 'client', allow: ['apply_patch'] });
    expect(manifest.virtualRouterBootstrapInput.hitLog).toEqual({ enabled: true, omit: ['headers'] });
    expect(manifest.pipelineRuntimeConfig.applyPatch).toEqual({ mode: 'client', allow: ['apply_patch'] });
    expect(manifest.pipelineRuntimeConfig.routingProviderIds).toEqual(['freepool']);
    expect(manifest.pipelineRuntimeConfig.routingTiersByRoute).toEqual({
      default: [
        {
          id: 'beta-route',
          targets: ['fwd.gpt.gpt-5.5'],
          priority: 0
        }
      ]
    });
  });

  it('fails fast when a forwarder provider target does not declare the requested model', () => {
    expect(() => compileRouteCodexRuntimeManifestSync({
      userConfig: {
        virtualrouter: {
          forwarders: {
            'fwd.gpt.gpt-5.5': {
              protocol: 'openai',
              model: 'gpt-5.5',
              targets: [{ providerId: 'freepool' }]
            }
          },
          routingPolicyGroups: {
            default: {
              routing: { default: [{ id: 'default', target: 'fwd.gpt.gpt-5.5' }] }
            }
          }
        }
      },
      providerConfigs: {
        freepool: providerConfig('freepool', {
          type: 'openai',
          auth: { entries: [{ alias: 'key1', apiKey: 'test-key' }] },
          models: {
            'other-model': { capabilities: ['text'] }
          }
        })
      }
    })).toThrow("[forwarder-config] fwd.gpt.gpt-5.5 target 'freepool' does not declare model 'gpt-5.5'");
  });

  it('uses materialized virtualrouter.providers before provider root loading', async () => {
    const userConfig = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      virtualrouter: {
        providers: {
          mock: {
            id: 'mock',
            type: 'openai',
            baseURL: 'https://materialized-provider.example.test/v1',
            auth: {
              type: 'apikey',
              entries: [{ alias: 'default', value: 'mock-key' }]
            },
            models: {
              'gpt-5.1': { supportsStreaming: true }
            }
          }
        },
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                { id: 'mock-default', targets: ['mock.default.gpt-5.1'] }
              ]
            }
          }
        }
      }
    };

    const manifest = await compileRouteCodexRuntimeConfigManifest(
      userConfig,
      '/routecodex-test-provider-root-must-not-be-read'
    );

    expect(manifest.providerIds).toEqual(['mock']);
    expect(manifest.virtualRouterBootstrapInput).toMatchObject({
      providers: {
        mock: {
          id: 'mock',
          baseURL: 'https://materialized-provider.example.test/v1'
        }
      },
      routing: {
        default: [
          expect.objectContaining({
            targets: ['mock.default.gpt-5.1']
          })
        ]
      }
    });
  });
});
