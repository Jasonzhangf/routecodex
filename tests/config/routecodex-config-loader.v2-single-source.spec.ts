import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadRouteCodexConfig } from '../../src/config/routecodex-config-loader.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

type EnvSnapshot = Record<
  'RCC_HOME' | 'ROUTECODEX_USER_DIR' | 'ROUTECODEX_HOME',
  string | undefined
>;

function takeEnv(): EnvSnapshot {
  return {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot) as Array<[keyof EnvSnapshot, string | undefined]>) {
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

async function writeProviderConfig(root: string): Promise<void> {
  const providerDir = path.join(root, 'provider', 'ali-coding-plan');
  await fs.mkdir(providerDir, { recursive: true });
  const providerPayload = {
    version: '2.0.0',
    providerId: 'ali-coding-plan',
    provider: {
      id: 'ali-coding-plan',
      type: 'anthropic',
      baseURL: 'https://example.test/anthropic',
      auth: { type: 'apikey', apiKey: '${ALI_CODINGPLAN_KEY}' },
      models: {
        'glm-5': { supportsStreaming: true, capabilities: ['web_search'] },
        'qwen3.5-plus': { supportsStreaming: true, capabilities: ['web_search', 'multimodal'] }
      }
    }
  };
  await fs.writeFile(path.join(providerDir, 'config.v2.json'), `${JSON.stringify(providerPayload, null, 2)}\n`, 'utf8');
}

describe('loadRouteCodexConfig v2 single-source layout', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = takeEnv();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('does not mutate config files with synthesized capability routes', async () => {
    const root = await mkTmp('routecodex-v2-single-source-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    const configPayload = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      httpserver: {
        host: '127.0.0.1',
        port: 5555
      },
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
    await fs.writeFile(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

    const before = await fs.readFile(configPath, 'utf8');
    const loaded = await loadRouteCodexConfig(configPath);
    const after = await fs.readFile(configPath, 'utf8');

    expect(after).toBe(before);
    expect(loaded.userConfig.virtualrouter).toBeTruthy();
    expect((loaded.userConfig.virtualrouter as any).routing.multimodal).toBeUndefined();
    expect((loaded.userConfig.virtualrouter as any).routing.web_search).toBeUndefined();
  });

  it('rejects legacy v1 fields instead of silently sanitizing them', async () => {
    const root = await mkTmp('routecodex-v2-single-source-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    const configPayload = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      httpserver: {
        host: '127.0.0.1',
        port: 5555
      },
      providers: {
        legacy: {}
      },
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
    await fs.writeFile(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

    await expect(loadRouteCodexConfig(configPath)).rejects.toThrow('v2 config disallows top-level field "providers"');
  });

  it('allows router sameProtocolBehavior in top-level httpserver config', async () => {
    const root = await mkTmp('routecodex-v2-same-protocol-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        version: '2.0.0',
        virtualrouterMode: 'v2',
        httpserver: {
          host: '127.0.0.1',
          port: 5555,
          sameProtocolBehavior: 'relay'
        },
        virtualrouter: {
          routingPolicyGroups: {
            default: {
              routing: {
                default: [{ id: 'default-primary', targets: ['ali-coding-plan.glm-5'] }]
              }
            }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    const loaded = await loadRouteCodexConfig(configPath);
    expect((loaded.userConfig.httpserver as any).sameProtocolBehavior).toBe('relay');
  });

  it('materializes existing v2 routingPolicyGroups without rewriting legacy runtime selector fields', async () => {
    const root = await mkTmp('routecodex-v2-existing-selector-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    const configPayload = {
      version: '2.0.0',
      httpserver: {
        host: '127.0.0.1',
        port: 5555
      },
      virtualrouter: {
        activeRoutingPolicyGroup: 'canary',
        routingPolicyGroups: {
          default: {
            routing: {
              default: [{ id: 'default-primary', targets: ['ali-coding-plan.glm-5'] }]
            }
          },
          canary: {
            routing: {
              default: [{ id: 'canary-primary', targets: ['ali-coding-plan.qwen3.5-plus'] }]
            }
          }
        },
        routing: {
          default: [{ id: 'stale-runtime-copy', targets: ['ali-coding-plan.glm-5'] }]
        }
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

    const before = await fs.readFile(configPath, 'utf8');
    const loaded = await loadRouteCodexConfig(configPath);
    const after = await fs.readFile(configPath, 'utf8');

    expect(after).toBe(before);
    expect(loaded.userConfig.virtualrouterMode).toBe('v2');
    expect((loaded.userConfig.virtualrouter as any).routing.default[0].id).toBe('canary-primary');
  });

  it('rejects routingPolicyGroup without explicit non-empty default route skeleton', async () => {
    const root = await mkTmp('routecodex-v2-default-skeleton-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        version: '2.0.0',
        virtualrouterMode: 'v2',
        httpserver: {
          host: '127.0.0.1',
          port: 5555
        },
        virtualrouter: {
          routingPolicyGroups: {
            default: {
              routing: {
                coding: [{ id: 'coding-primary', targets: ['ali-coding-plan.glm-5'] }]
              }
            }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    await expect(loadRouteCodexConfig(configPath)).rejects.toThrow(
      'routingPolicyGroups["default"].routing.default'
    );
  });

  it('rejects routingPolicyGroup whose default route has no provider targets', async () => {
    const root = await mkTmp('routecodex-v2-default-empty-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        version: '2.0.0',
        virtualrouterMode: 'v2',
        httpserver: {
          host: '127.0.0.1',
          port: 5555
        },
        virtualrouter: {
          routingPolicyGroups: {
            default: {
              routing: {
                default: [{ id: 'default-empty', targets: [] }]
              }
            }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    await expect(loadRouteCodexConfig(configPath)).rejects.toThrow(
      'routingPolicyGroups["default"].routing.default'
    );
  });

  it('does not stick to a previous auto-resolved config path', async () => {
    const rootA = await mkTmp('routecodex-v2-path-a-');
    process.env.RCC_HOME = rootA;
    process.env.ROUTECODEX_USER_DIR = rootA;
    process.env.ROUTECODEX_HOME = rootA;
    await writeProviderConfig(rootA);
    await fs.writeFile(
      path.join(rootA, 'config.toml'),
      `version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 5555

[virtualrouter.routingPolicyGroups.default.routing]
default = [{ id = "a", targets = ["ali-coding-plan.glm-5"] }]
`,
      'utf8'
    );

    const first = await loadRouteCodexConfig();
    expect(first.configPath).toBe(path.join(rootA, 'config.toml'));

    const rootB = await mkTmp('routecodex-v2-path-b-');
    process.env.RCC_HOME = rootB;
    process.env.ROUTECODEX_USER_DIR = rootB;
    process.env.ROUTECODEX_HOME = rootB;
    await writeProviderConfig(rootB);
    await fs.writeFile(
      path.join(rootB, 'config.toml'),
      `version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 6666

[virtualrouter.routingPolicyGroups.default.routing]
default = [{ id = "b", targets = ["ali-coding-plan.qwen3.5-plus"] }]
`,
      'utf8'
    );

    const second = await loadRouteCodexConfig();
    expect(second.configPath).toBe(path.join(rootB, 'config.toml'));
    expect((second.userConfig.httpserver as any).port).toBe(6666);
  });
});

describe('loadRouteCodexConfig TOML support', () => {
  it('loads a TOML config when explicit .toml path is provided', async () => {
    const root = await mkTmp('routecodex-v2-toml-loader-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.toml');
    const tomlPayload = `version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 5555

[[virtualrouter.routingPolicyGroups.default.routing.default]]
id = "default-primary"
targets = ["ali-coding-plan.glm-5"]
`;
    await fs.writeFile(configPath, tomlPayload, 'utf8');

    const loaded = await loadRouteCodexConfig(configPath);
    expect(loaded.configPath).toBe(configPath);
    expect((loaded.userConfig.httpserver as any).port).toBe(5555);
    expect(loaded.userConfig.virtualrouter).toBeTruthy();
  });
});
