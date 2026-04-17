import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadRouteCodexConfig } from '../../src/config/routecodex-config-loader.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

type EnvSnapshot = Record<'RCC_HOME' | 'ROUTECODEX_USER_DIR' | 'ROUTECODEX_HOME', string | undefined>;

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

describe('loadRouteCodexConfig v2 capability-route persistence', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = takeEnv();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('auto-injects and persists multimodal/web_search routes when active policy misses them', async () => {
    const root = await mkTmp('routecodex-v2-capability-');
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
        activeRoutingPolicyGroup: 'default',
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

    const loaded = await loadRouteCodexConfig(configPath);
    expect(loaded.userConfig.virtualrouter).toBeTruthy();

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const routing = persisted.virtualrouter.routingPolicyGroups.default.routing;
    expect(Array.isArray(routing.multimodal)).toBe(true);
    expect(Array.isArray(routing.web_search)).toBe(true);
    expect(routing.multimodal[0].loadBalancing.order).toContain('ali-coding-plan.qwen3.5-plus');
    expect(routing.web_search[0].loadBalancing.order).toEqual([
      'ali-coding-plan.glm-5',
      'ali-coding-plan.qwen3.5-plus'
    ]);
  });

  it('respects explicit multimodal config and only injects missing capability routes', async () => {
    const root = await mkTmp('routecodex-v2-capability-');
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
        activeRoutingPolicyGroup: 'default',
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
              ]
            }
          }
        }
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

    await loadRouteCodexConfig(configPath);
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const routing = persisted.virtualrouter.routingPolicyGroups.default.routing;
    expect(routing.multimodal[0].id).toBe('manual-multimodal');
    expect(routing.multimodal[0].targets).toEqual(['ali-coding-plan.manual-vl']);
    expect(Array.isArray(routing.web_search)).toBe(true);
    expect(routing.web_search[0].loadBalancing.order).toEqual([
      'ali-coding-plan.glm-5',
      'ali-coding-plan.qwen3.5-plus'
    ]);
  });

  it('treats web_search weights-only pools as already configured', async () => {
    const root = await mkTmp('routecodex-v2-capability-');
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
        activeRoutingPolicyGroup: 'default',
        routingPolicyGroups: {
          default: {
            routing: {
              default: [{ id: 'default-primary', targets: ['ali-coding-plan.glm-5'] }],
              web_search: [
                {
                  id: 'weights-only-websearch',
                  loadBalancing: {
                    strategy: 'weighted',
                    weights: {
                      'ali-coding-plan.glm-5': 1
                    }
                  }
                }
              ]
            }
          }
        }
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

    await loadRouteCodexConfig(configPath);
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const routing = persisted.virtualrouter.routingPolicyGroups.default.routing;
    expect(Array.isArray(routing.web_search)).toBe(true);
    expect(routing.web_search[0].id).toBe('weights-only-websearch');
    expect(routing.web_search[0].loadBalancing.weights).toEqual({
      'ali-coding-plan.glm-5': 1
    });
  });
});
