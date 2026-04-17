import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadProviderConfigsV2 } from '../../src/config/provider-v2-loader.js';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import type { UnknownRecord } from '../../src/config/virtual-router-types.js';

async function createTempDir(prefix: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
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
