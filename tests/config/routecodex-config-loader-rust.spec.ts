import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadRouteCodexConfig } from '../../src/config/routecodex-config-loader.js';
import { serializeTomlRecord } from '../../src/config/toml-basic.js';
import { loadRouteCodexConfigWithNative } from '../sharedmodule/helpers/config-direct-native.js';

type EnvSnapshot = Record<
  | 'RCC_HOME'
  | 'ROUTECODEX_USER_DIR'
  | 'ROUTECODEX_HOME'
  | 'ROUTECODEX_PROVIDER_DIR'
  | 'RCC_PROVIDER_DIR'
  | 'ROUTECODEX_CONFIG_PATH'
  | 'ROUTECODEX_CONFIG',
  string | undefined
>;

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function takeEnv(): EnvSnapshot {
  return {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME,
    ROUTECODEX_PROVIDER_DIR: process.env.ROUTECODEX_PROVIDER_DIR,
    RCC_PROVIDER_DIR: process.env.RCC_PROVIDER_DIR,
    ROUTECODEX_CONFIG_PATH: process.env.ROUTECODEX_CONFIG_PATH,
    ROUTECODEX_CONFIG: process.env.ROUTECODEX_CONFIG
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

async function writeProviderConfig(root: string, baseURL = 'https://provider-root.example.test/anthropic'): Promise<void> {
  await writeProviderConfigAtProviderRoot(path.join(root, 'provider'), baseURL);
}

async function writeProviderConfigAtProviderRoot(
  providerRoot: string,
  baseURL = 'https://provider-root.example.test/anthropic'
): Promise<void> {
  const providerDir = path.join(providerRoot, 'ali-coding-plan');
  await fs.mkdir(providerDir, { recursive: true });
  await fs.writeFile(
    path.join(providerDir, 'config.v2.toml'),
    `${serializeTomlRecord({
      version: '2.0.0',
      providerId: 'ali-coding-plan',
      provider: {
        id: 'ali-coding-plan',
        type: 'anthropic',
        baseURL,
        auth: { type: 'apikey', apiKey: '${ALI_CODINGPLAN_KEY}' },
        models: {
          'glm-5': { supportsStreaming: true },
          'qwen3.5-plus': { supportsStreaming: true, capabilities: ['web_search'] }
        }
      }
    })}\n`,
    'utf8'
  );
}

async function writeUserConfig(configPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.writeFile(configPath, `${serializeTomlRecord(payload)}\n`, 'utf8');
}

function userConfig(port = 5555, routeId = 'default-primary', target = 'ali-coding-plan.glm-5'): Record<string, unknown> {
  return {
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      host: '127.0.0.1',
      port,
      ports: [
        {
          port,
          host: '127.0.0.1',
          mode: 'router',
          routingPolicyGroup: 'default'
        }
      ]
    },
    virtualrouter: {
      routingPolicyGroups: {
        default: {
          routing: {
            default: [{ id: routeId, targets: [target] }]
          }
        }
      }
    }
  };
}

function stableLoadedView(loaded: Awaited<ReturnType<typeof loadRouteCodexConfig>>): Record<string, unknown> {
  const virtualrouter = loaded.userConfig.virtualrouter as any;
  const httpserver = loaded.userConfig.httpserver as any;
  const providerProfiles = loaded.providerProfiles as any;
  return {
    configPath: loaded.configPath,
    port: httpserver?.port,
    routeId: virtualrouter?.routing?.default?.[0]?.id,
    routeTarget: virtualrouter?.routing?.default?.[0]?.targets?.[0],
    providerBaseURL: virtualrouter?.providers?.['ali-coding-plan']?.baseURL,
    providerProfileIds: Object.keys(providerProfiles?.byId ?? providerProfiles?.providers ?? providerProfiles ?? {}).sort()
  };
}

describe('loadRouteCodexConfig native loader parity before wiring', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = takeEnv();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('matches the TS loader for explicit TOML config plus default provider root from env snapshot', async () => {
    const root = await mkTmp('routecodex-loader-native-explicit-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    delete process.env.ROUTECODEX_PROVIDER_DIR;
    delete process.env.RCC_PROVIDER_DIR;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.toml');
    await writeUserConfig(configPath, userConfig());

    const legacy = await loadRouteCodexConfig(configPath);
    const native = loadRouteCodexConfigWithNative({ explicitPath: configPath }) as Awaited<ReturnType<typeof loadRouteCodexConfig>>;

    expect(stableLoadedView(native)).toEqual(stableLoadedView(legacy));
  });

  it('matches the TS loader when ROUTECODEX_PROVIDER_DIR overrides the default provider root', async () => {
    const root = await mkTmp('routecodex-loader-native-provider-env-');
    const providerRoot = path.join(root, 'external-provider-root');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    process.env.ROUTECODEX_PROVIDER_DIR = providerRoot;
    delete process.env.RCC_PROVIDER_DIR;
    await writeProviderConfigAtProviderRoot(providerRoot, 'https://external-provider-root.example.test/anthropic');

    const configPath = path.join(root, 'config.toml');
    await writeUserConfig(configPath, userConfig());

    const legacy = await loadRouteCodexConfig(configPath);
    const native = loadRouteCodexConfigWithNative({ explicitPath: configPath }) as Awaited<ReturnType<typeof loadRouteCodexConfig>>;

    expect(stableLoadedView(native)).toEqual(stableLoadedView(legacy));
    expect(stableLoadedView(native).providerBaseURL).toBe('https://external-provider-root.example.test/anthropic');
  });

  it('matches the TS loader for auto-resolved config path without sticky cache', async () => {
    const rootA = await mkTmp('routecodex-loader-native-auto-a-');
    process.env.RCC_HOME = rootA;
    process.env.ROUTECODEX_USER_DIR = rootA;
    process.env.ROUTECODEX_HOME = rootA;
    delete process.env.ROUTECODEX_PROVIDER_DIR;
    delete process.env.RCC_PROVIDER_DIR;
    await writeProviderConfig(rootA);
    await writeUserConfig(path.join(rootA, 'config.toml'), userConfig(5555, 'route-a', 'ali-coding-plan.glm-5'));

    const legacyA = await loadRouteCodexConfig();
    const nativeA = loadRouteCodexConfigWithNative() as Awaited<ReturnType<typeof loadRouteCodexConfig>>;
    expect(stableLoadedView(nativeA)).toEqual(stableLoadedView(legacyA));

    const rootB = await mkTmp('routecodex-loader-native-auto-b-');
    process.env.RCC_HOME = rootB;
    process.env.ROUTECODEX_USER_DIR = rootB;
    process.env.ROUTECODEX_HOME = rootB;
    await writeProviderConfig(rootB);
    await writeUserConfig(path.join(rootB, 'config.toml'), userConfig(6666, 'route-b', 'ali-coding-plan.qwen3.5-plus'));

    const legacyB = await loadRouteCodexConfig();
    const nativeB = loadRouteCodexConfigWithNative() as Awaited<ReturnType<typeof loadRouteCodexConfig>>;
    expect(stableLoadedView(nativeB)).toEqual(stableLoadedView(legacyB));
  });

  it('matches TS loader rejection for legacy v1 source fields', async () => {
    const root = await mkTmp('routecodex-loader-native-v1-reject-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.toml');
    await writeUserConfig(configPath, {
      ...userConfig(),
      providers: {
        legacy: {}
      }
    });

    await expect(loadRouteCodexConfig(configPath)).rejects.toThrow('v2 config disallows top-level field "providers"');
    expect(() => loadRouteCodexConfigWithNative({ explicitPath: configPath })).toThrow(
      'v2 config disallows top-level field "providers"'
    );
  });

  it('matches TS loader rejection for JSON config files', async () => {
    const root = await mkTmp('routecodex-loader-native-json-reject-');
    process.env.RCC_HOME = root;
    process.env.ROUTECODEX_USER_DIR = root;
    process.env.ROUTECODEX_HOME = root;
    await writeProviderConfig(root);

    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, '{"version":"2.0.0"}\n', 'utf8');

    await expect(loadRouteCodexConfig(configPath)).rejects.toThrow('user config JSON support removed');
    expect(() => loadRouteCodexConfigWithNative({ explicitPath: configPath })).toThrow(
      'user config JSON support removed'
    );
  });
});
