import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadProviderConfigsV2 } from '../../src/config/provider-v2-loader.js';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import { materializeRouteCodexConfig } from '../../src/config/user-config-loader.js';
import type { UnknownRecord } from '../../src/config/virtual-router-types.js';

async function createTempDir(prefix: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
}

function routeTargets(routing: Record<string, unknown>, routeName: string): string[] {
  const value = routing[routeName];
  const pools = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    const targets = (pool as Record<string, unknown>).targets;
    if (Array.isArray(targets)) {
      for (const target of targets) {
        if (typeof target === 'string') out.push(target);
      }
    }
  }
  return out;
}

describe('ProviderConfig v2 loader', () => {
  const originalEnv = {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME
  };

  afterEach(() => {
    if (typeof originalEnv.RCC_HOME === 'string') {
      process.env.RCC_HOME = originalEnv.RCC_HOME;
    } else {
      delete process.env.RCC_HOME;
    }
    if (typeof originalEnv.ROUTECODEX_USER_DIR === 'string') {
      process.env.ROUTECODEX_USER_DIR = originalEnv.ROUTECODEX_USER_DIR;
    } else {
      delete process.env.ROUTECODEX_USER_DIR;
    }
    if (typeof originalEnv.ROUTECODEX_HOME === 'string') {
      process.env.ROUTECODEX_HOME = originalEnv.ROUTECODEX_HOME;
    } else {
      delete process.env.ROUTECODEX_HOME;
    }
  });

  it('skips provider directories without config.v2.json', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'foo');
    await fs.mkdir(providerDir, { recursive: true });

    const v1Config = {
      virtualrouter: {
        providers: {
          foo: {
            type: 'mock-provider',
            baseURL: 'https://example.com',
            models: {
              'mock-1': { maxTokens: 1024 }
            }
          }
        }
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v1.json'),
      `${JSON.stringify(v1Config, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs)).not.toContain('foo');

    const v2Path = path.join(providerDir, 'config.v2.json');
    await expect(fs.readFile(v2Path, 'utf8')).rejects.toThrow();
  });

  it('prefers existing config.v2.json when present', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'bar');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'bar',
      provider: {
        type: 'mock-provider',
        baseURL: 'https://bar.example.com'
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs)).toContain('bar');
    const cfg = configs.bar;
    expect(cfg.providerId).toBe('bar');
    expect(cfg.provider.baseURL).toBe('https://bar.example.com');
  });

  it('treats config.v2.toml/json as one base config and prefers toml when both exist', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'deepseek-web');
    await fs.mkdir(providerDir, { recursive: true });

    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(
        {
          version: '2.0.0',
          providerId: 'deepseek-web',
          provider: {
            id: 'deepseek-web',
            type: 'openai',
            baseURL: 'https://json.example.com'
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(providerDir, 'config.v2.toml'),
      [
        'version = "2.0.0"',
        'providerId = "deepseek-web"',
        '',
        '[provider]',
        'id = "deepseek-web"',
        'type = "openai"',
        'baseURL = "https://toml.example.com"',
        ''
      ].join('\n'),
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs)).toEqual(['deepseek-web']);
    expect(configs['deepseek-web']?.provider.baseURL).toBe('https://toml.example.com');
  });
});

describe('buildVirtualRouterInputV2', () => {
  it('combines provider v2 configs with routing from userConfig', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'demo',
      provider: {
        type: 'mock-provider',
        baseURL: 'https://demo.example.com'
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const userConfig: UnknownRecord = {
      virtualrouter: {
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                {
                  id: 'primary',
                  targets: ['demo.mock-1']
                }
              ]
            }
          }
        }
      }
    };

    const input = await buildVirtualRouterInputV2(userConfig, root);
    expect(Object.keys(input.providers)).toEqual(['demo']);
    expect(input.providers.demo.type).toBe('mock-provider');
    expect(input.routing.default).toHaveLength(1);
    expect(input.routing.default[0].targets).toEqual(['demo.mock-1']);
  });

  it('keeps provider configs referenced by singular route target', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'mini27');
    await fs.mkdir(providerDir, { recursive: true });

    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'mini27',
        provider: {
          id: 'mini27',
          type: 'openai',
          baseURL: 'https://mini27.example.test/v1',
          defaultModel: 'MiniMax-M2.7'
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const input = await buildVirtualRouterInputV2({
      virtualrouter: {
        routingPolicyGroups: {
          default: {
            routing: {
              default: [{ id: 'default-mini27', target: 'mini27.MiniMax-M2.7' }]
            }
          }
        }
      }
    }, root);

    expect(Object.keys(input.providers)).toEqual(['mini27']);
    expect(input.routing.default?.[0]?.target).toBe('mini27.MiniMax-M2.7');
  });

  it('materializes virtualrouter.forwarders and keeps their target providers', async () => {
    const root = await createTempDir('provider-v2-');
    for (const providerId of ['minimax', 'mini27']) {
      const providerDir = path.join(root, providerId);
      await fs.mkdir(providerDir, { recursive: true });
      await fs.writeFile(
        path.join(providerDir, 'config.v2.json'),
        `${JSON.stringify({
          version: '2.0.0',
          providerId,
          provider: {
            type: 'anthropic',
            baseURL: `https://${providerId}.example.test`,
            auth: {
              entries: [{ alias: 'key1', apiKey: 'test-key' }]
            },
            models: {
              'MiniMax-M3': { capabilities: ['tools', 'multimodal'] }
            }
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    const userConfig: UnknownRecord = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      virtualrouter: {
        forwarders: {
          'fwd.minimax.MiniMax-M3': {
            protocol: 'anthropic',
            model: 'MiniMax-M3',
            strategy: 'priority',
            targets: [
              { providerId: 'minimax', priority: 1 },
              { providerId: 'mini27', priority: 2 }
            ]
          }
        },
        routingPolicyGroups: {
          gateway_priority_5520: {
            routing: {
              default: [{ id: 'default', target: 'fwd.minimax.MiniMax-M3' }]
            }
          }
        }
      }
    };

    const materialized = await materializeRouteCodexConfig(userConfig, root);

    expect(Object.keys(materialized.userConfig.virtualrouter?.providers as Record<string, unknown>).sort()).toEqual([
      'mini27',
      'minimax'
    ]);
    expect(materialized.userConfig.virtualrouter?.forwarders).toEqual(
      expect.objectContaining({
        'fwd.minimax.MiniMax-M3': expect.objectContaining({
          forwarderId: 'fwd.minimax.MiniMax-M3',
          modelId: 'MiniMax-M3',
          targets: expect.arrayContaining([
            expect.objectContaining({ providerKey: 'minimax.key1.MiniMax-M3' }),
            expect.objectContaining({ providerKey: 'mini27.key1.MiniMax-M3' })
          ])
        })
      })
    );
  });

  it('materializes multiple forwarders for the same protocol and model', async () => {
    const root = await createTempDir('provider-v2-');
    for (const providerId of ['paid', 'free']) {
      const providerDir = path.join(root, providerId);
      await fs.mkdir(providerDir, { recursive: true });
      await fs.writeFile(
        path.join(providerDir, 'config.v2.json'),
        `${JSON.stringify({
          version: '2.0.0',
          providerId,
          provider: {
            id: providerId,
            type: 'openai',
            baseURL: `https://${providerId}.example.test/v1`,
            auth: {
              entries: [{ alias: 'key1', apiKey: 'test-key' }]
            },
            models: {
              'gpt-5.3-codex-spark': { capabilities: ['tools', 'thinking'] }
            }
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    const input = await buildVirtualRouterInputV2({
      virtualrouter: {
        forwarders: {
          'fwd.paid.gpt-5.3-codex-spark': {
            protocol: 'openai',
            model: 'gpt-5.3-codex-spark',
            strategy: 'priority',
            targets: [{ providerId: 'paid', priority: 1 }]
          },
          'fwd.gpt.gpt-5.3-codex-spark': {
            protocol: 'openai',
            model: 'gpt-5.3-codex-spark',
            strategy: 'priority',
            targets: [{ providerId: 'free', priority: 1 }]
          }
        },
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                { id: 'paid-pool', targets: ['fwd.paid.gpt-5.3-codex-spark'] },
                { id: 'free-pool', targets: ['fwd.gpt.gpt-5.3-codex-spark'] }
              ]
            }
          }
        }
      }
    }, root);

    const forwarders = input.forwarders as Record<string, any>;
    expect(Object.keys(forwarders).sort()).toEqual([
      'fwd.gpt.gpt-5.3-codex-spark',
      'fwd.paid.gpt-5.3-codex-spark'
    ]);
    expect(forwarders['fwd.paid.gpt-5.3-codex-spark'].targets).toEqual([
      expect.objectContaining({ providerKey: 'paid.key1.gpt-5.3-codex-spark' })
    ]);
    expect(forwarders['fwd.gpt.gpt-5.3-codex-spark'].targets).toEqual([
      expect.objectContaining({ providerKey: 'free.key1.gpt-5.3-codex-spark' })
    ]);
  });

  it('materializes providerId-only multimodal forwarder targets into real provider keys', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'media');
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'media',
        provider: {
          id: 'media',
          type: 'openai',
          baseURL: 'https://media.example.test/v1',
          auth: {
            entries: [{ alias: 'key1', apiKey: 'test-key' }]
          },
          models: {
            'gpt-5.4-mini': { capabilities: ['text', 'multimodal'] }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const input = await buildVirtualRouterInputV2({
      virtualrouter: {
        forwarders: {
          'fwd.gpt.gpt-5.4-mini': {
            protocol: 'openai',
            model: 'gpt-5.4-mini',
            resolutionMode: 'model-first',
            strategy: 'round-robin',
            stickyKey: 'none',
            targets: [{ providerId: 'media' }]
          }
        },
        routingPolicyGroups: {
          default: {
            routing: {
              multimodal: [
                {
                  id: 'multimodal-forwarder',
                  targets: ['fwd.gpt.gpt-5.4-mini']
                }
              ],
              default: [
                {
                  id: 'default-text',
                  targets: ['media.key1.gpt-5.4-mini']
                }
              ]
            }
          }
        }
      }
    }, root);

    const forwarders = input.forwarders as Record<string, any>;
    expect(forwarders['fwd.gpt.gpt-5.4-mini'].targets).toEqual([
      expect.objectContaining({
        providerId: 'media',
        providerKey: 'media.key1.gpt-5.4-mini'
      })
    ]);
    expect((input.providers.media.models as any)['gpt-5.4-mini'].capabilities).toContain('multimodal');
  });

  it('expands one forwarder provider target into all provider auth keys', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'freepool');
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'freepool',
        provider: {
          id: 'freepool',
          type: 'openai',
          baseURL: 'https://freepool.example.test/v1',
          auth: {
            entries: [
              { alias: 'key1', apiKey: 'test-key-1' },
              { alias: 'key2', apiKey: 'test-key-2' }
            ]
          },
          models: {
            'gpt-5.5': { capabilities: ['text', 'thinking', 'longcontext'] }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const input = await buildVirtualRouterInputV2({
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
          default: {
            routing: {
              thinking: [{ id: 'thinking-forwarder', targets: ['fwd.gpt.gpt-5.5'] }]
            }
          }
        }
      }
    }, root);

    expect(routeTargets(input.routing, 'thinking')).toEqual(['fwd.gpt.gpt-5.5']);
    const forwarders = input.forwarders as Record<string, any>;
    expect(forwarders['fwd.gpt.gpt-5.5'].targets).toEqual([
      expect.objectContaining({ providerId: 'freepool', providerKey: 'freepool.key1.gpt-5.5', weight: 3 }),
      expect.objectContaining({ providerId: 'freepool', providerKey: 'freepool.key2.gpt-5.5', weight: 3 })
    ]);
  });


  it('normalizes top-level servertool.apply_patch freeform mode into client virtual router input', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: { type: 'mock-provider', baseURL: 'https://demo.example.com' }
      }, null, 2)}
`,
      'utf8'
    );

    const input = await buildVirtualRouterInputV2({
      servertool: { apply_patch: { mode: 'freeform' } },
      virtualrouter: {
        routingPolicyGroups: {
          default: { routing: { default: [{ id: 'primary', targets: ['demo.mock-1'] }] } }
        }
      }
    }, root);

    expect(input.applyPatch).toEqual({ mode: 'client' });
  });



  it('materializes servertool.apply_patch freeform mode into client runtime bootstrap config', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: { type: 'mock-provider', baseURL: 'https://demo.example.com' }
      }, null, 2)}
`,
      'utf8'
    );

    const materialized = await materializeRouteCodexConfig({
      version: '2.0.0',
      virtualrouterMode: 'v2',
      servertool: { apply_patch: { mode: 'freeform' } },
      httpserver: { port: 10000, host: '127.0.0.1' },
      virtualrouter: {
        routingPolicyGroups: {
          default: { routing: { default: [{ id: 'primary', targets: ['demo.mock-1'] }] } }
        }
      }
    }, root);

    expect((materialized.userConfig.virtualrouter as any).applyPatch).toEqual({ mode: 'client' });
  });

  it('materializes only the primary router port routing policy group', async () => {
    const root = await createTempDir('provider-v2-');
    for (const providerId of ['alpha', 'beta']) {
      const providerDir = path.join(root, providerId);
      await fs.mkdir(providerDir, { recursive: true });
      await fs.writeFile(
        path.join(providerDir, 'config.v2.json'),
        `${JSON.stringify({
          version: '2.0.0',
          providerId,
          provider: { type: 'mock-provider', baseURL: `https://${providerId}.example.com` }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    const materialized = await materializeRouteCodexConfig({
      version: '2.0.0',
      virtualrouterMode: 'v2',
      httpserver: {
        ports: [
          { port: 5520, mode: 'router', routingPolicyGroup: 'group_a' },
          { port: 5555, mode: 'router', routingPolicyGroup: 'group_b' }
        ]
      },
      virtualrouter: {
        routingPolicyGroups: {
          group_a: { routing: { default: [{ id: 'route-a', targets: ['alpha.model-a'] }] } },
          group_b: { routing: { default: [{ id: 'route-b', targets: ['beta.model-b'] }] } }
        }
      }
    }, root);

    expect((materialized.userConfig.virtualrouter as any).routing.default).toEqual([
      expect.objectContaining({ id: 'route-a' })
    ]);
    expect((materialized.userConfig.virtualrouter as any).providers).toHaveProperty('alpha');
    expect((materialized.userConfig.virtualrouter as any).providers).not.toHaveProperty('beta');
  });

  it('does not auto-synthesize capability routes when route pools are absent', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'ali-coding-plan');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'ali-coding-plan',
      provider: {
        id: 'ali-coding-plan',
        type: 'anthropic',
        baseURL: 'https://example.test/anthropic',
        models: {
          'glm-5': { capabilities: ['web_search'] },
          'kimi-k2.5': { capabilities: ['web_search', 'vision'] },
          'qwen3.5-plus': { capabilities: ['web_search', 'multimodal'] }
        }
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const userConfig: UnknownRecord = {
      virtualrouter: {
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                {
                  id: 'default-primary',
                  targets: ['ali-coding-plan.glm-5']
                }
              ]
            }
          }
        }
      }
    };

    const input = await buildVirtualRouterInputV2(userConfig, root);
    expect(input.routing.multimodal).toBeUndefined();
    expect(input.routing.web_search).toBeUndefined();
  });

  it('keeps explicitly configured capability routes without injecting additional ones', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'ali-coding-plan');
    await fs.mkdir(providerDir, { recursive: true });

    const v2Payload = {
      version: '2.0.0',
      providerId: 'ali-coding-plan',
      provider: {
        id: 'ali-coding-plan',
        type: 'anthropic',
        baseURL: 'https://example.test/anthropic',
        models: {
          'qwen3.5-plus': { capabilities: ['web_search', 'multimodal'] }
        }
      }
    };
    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(v2Payload, null, 2)}\n`,
      'utf8'
    );

    const userConfig: UnknownRecord = {
      virtualrouter: {
        routingPolicyGroups: {
          default: {
            routing: {
              default: [
                {
                  id: 'default-primary',
                  targets: ['ali-coding-plan.glm-5']
                }
              ],
              multimodal: [
                {
                  id: 'manual-multimodal',
                  targets: ['ali-coding-plan.manual-vl']
                }
              ],
              web_search: [
                {
                  id: 'manual-web-search',
                  targets: ['ali-coding-plan.manual-search']
                }
              ]
            }
          }
        }
      }
    };

    const input = await buildVirtualRouterInputV2(userConfig, root);
    expect(input.routing.multimodal).toHaveLength(1);
    expect(input.routing.multimodal[0].id).toBe('manual-multimodal');
    expect(input.routing.multimodal[0].targets).toEqual(['ali-coding-plan.manual-vl']);
    expect(input.routing.web_search?.[0]?.targets).toEqual(['ali-coding-plan.manual-search']);
  });

  it('loads suffixed provider configs as standalone providers with explicit providerId', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'ali-coding-plan');
    await fs.mkdir(providerDir, { recursive: true });

    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify(
        {
          version: '2.0.0',
          providerId: 'ali-coding-plan',
          provider: {
            id: 'ali-coding-plan',
            type: 'anthropic',
            baseURL: 'https://example.test/anthropic',
            models: {
              'glm-5': { capabilities: ['web_search'] },
              'qwen3.5-plus': { capabilities: ['web_search', 'multimodal'] }
            }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(providerDir, 'config.v2.duck.json'),
      `${JSON.stringify(
        {
          version: '2.0.0',
          providerId: 'duck',
          provider: {
            id: 'duck',
            type: 'openai',
            baseURL: 'https://example.test/openai',
            models: {
              'mimo-v2-omni-free': { capabilities: ['vision'] }
            }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const configs = await loadProviderConfigsV2(root);
    expect(Object.keys(configs).sort()).toEqual(['ali-coding-plan', 'duck']);
    expect(configs.duck.provider.id).toBe('duck');
  });

  it('buildVirtualRouterInputV2 keeps provider-mode binding provider even if routing does not reference it', async () => {
    const root = await createTempDir('provider-v2-');
    const routingProviderDir = path.join(root, 'demo');
    const directProviderDir = path.join(root, 'dbittai-gpt');
    await fs.mkdir(routingProviderDir, { recursive: true });
    await fs.mkdir(directProviderDir, { recursive: true });

    await fs.writeFile(
      path.join(routingProviderDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: {
          id: 'demo',
          type: 'openai',
          baseURL: 'https://demo.example.com'
        }
      }, null, 2)}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(directProviderDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'dbittai-gpt',
        provider: {
          id: 'dbittai-gpt',
          type: 'responses',
          baseURL: 'https://dbittai.com/v1'
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const userConfig: UnknownRecord = {
      httpserver: {
        ports: [
          { port: 5555, mode: 'provider', providerBinding: 'dbittai-gpt.key1.gpt-5.4' }
        ]
      },
      virtualrouter: {
        routingPolicyGroups: {
          default: {
            routing: {
              default: [{ id: 'primary', targets: ['demo.gpt-4o'] }]
            }
          }
        }
      }
    };

    const input = await buildVirtualRouterInputV2(userConfig, root);
    expect(Object.keys(input.providers).sort()).toEqual(['dbittai-gpt', 'demo']);
  });

  it('rejects duplicate provider ids across suffixed config files', async () => {
    const root = await createTempDir('provider-v2-');
    const providerDir = path.join(root, 'openai');
    await fs.mkdir(providerDir, { recursive: true });

    await fs.writeFile(
      path.join(providerDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'openai',
        provider: {
          id: 'openai',
          type: 'openai',
          baseURL: 'https://example.test/openai'
        }
      }, null, 2)}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(providerDir, 'config.v2.wuzu.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'openai',
        provider: {
          id: 'openai',
          type: 'openai',
          baseURL: 'https://example.test/openai-wuzu'
        }
      }, null, 2)}\n`,
      'utf8'
    );

    await expect(loadProviderConfigsV2(root)).rejects.toThrow('duplicate providerId "openai"');
  });
}
);
