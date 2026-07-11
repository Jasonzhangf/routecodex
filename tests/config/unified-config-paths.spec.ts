import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveRouteCodexConfigPath } from '../../src/config/config-paths.js';
import { resolveRccConfigDir, resolveRccUserDir } from '../../src/config/user-data-paths.js';
import { resolveRouteCodexConfigPathWithNative } from '../sharedmodule/helpers/config-direct-native.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('UnifiedConfigPathResolver', () => {
  const envSnapshot = {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_CONFIG: process.env.ROUTECODEX_CONFIG,
    ROUTECODEX_CONFIG_PATH: process.env.ROUTECODEX_CONFIG_PATH,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('prefers config.toml in RCC user dir when explicit env path is absent', async () => {
    const root = await mkTmp('routecodex-config-paths-');
    process.env.RCC_HOME = path.join(root, '.rcc-home');
    process.env.ROUTECODEX_HOME = process.env.RCC_HOME;
    process.env.ROUTECODEX_USER_DIR = process.env.RCC_HOME;
    const configPath = path.join(process.env.RCC_HOME, 'config.toml');
    await fs.mkdir(process.env.RCC_HOME, { recursive: true });
    await fs.writeFile(configPath, 'version = "2.0.0"\n', 'utf8');
    delete process.env.ROUTECODEX_CONFIG;
    delete process.env.ROUTECODEX_CONFIG_PATH;

    const previousCwd = process.cwd();
      process.chdir(root);
    try {
      expect(resolveRouteCodexConfigPath()).toBe(configPath);
      expect(resolveRouteCodexConfigPathWithNative()).toBe(configPath);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('fails fast when no config file exists', async () => {
    const root = await mkTmp('routecodex-config-paths-empty-');
    process.env.RCC_HOME = path.join(root, '.rcc-home');
    process.env.ROUTECODEX_HOME = process.env.RCC_HOME;
    process.env.ROUTECODEX_USER_DIR = process.env.RCC_HOME;
    delete process.env.ROUTECODEX_CONFIG;
    delete process.env.ROUTECODEX_CONFIG_PATH;

    await fs.mkdir(resolveRccUserDir(), { recursive: true });
    await fs.mkdir(resolveRccConfigDir(), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => resolveRouteCodexConfigPath()).toThrow('No configuration file found');
      expect(() => resolveRouteCodexConfigPathWithNative()).toThrow('No configuration file found');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not auto-fallback to legacy config.json when config.toml is absent', async () => {
    const root = await mkTmp('routecodex-config-paths-json-only-');
    process.env.RCC_HOME = path.join(root, '.rcc-home');
    process.env.ROUTECODEX_HOME = process.env.RCC_HOME;
    process.env.ROUTECODEX_USER_DIR = process.env.RCC_HOME;
    delete process.env.ROUTECODEX_CONFIG;
    delete process.env.ROUTECODEX_CONFIG_PATH;

    await fs.mkdir(process.env.RCC_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.RCC_HOME, 'config.json'), '{"version":"1"}\n', 'utf8');

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => resolveRouteCodexConfigPath()).toThrow('No configuration file found');
      expect(() => resolveRouteCodexConfigPathWithNative()).toThrow('No configuration file found');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('matches native config path resolution for explicit env config paths', async () => {
    const root = await mkTmp('routecodex-config-paths-env-');
    process.env.RCC_HOME = path.join(root, '.rcc-home');
    process.env.ROUTECODEX_HOME = process.env.RCC_HOME;
    process.env.ROUTECODEX_USER_DIR = process.env.RCC_HOME;
    const envConfigPath = path.join(root, 'explicit.toml');
    await fs.writeFile(envConfigPath, 'version = "2.0.0"\n', 'utf8');
    process.env.ROUTECODEX_CONFIG_PATH = envConfigPath;
    delete process.env.ROUTECODEX_CONFIG;

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      expect(resolveRouteCodexConfigPath()).toBe(envConfigPath);
      expect(resolveRouteCodexConfigPathWithNative()).toBe(envConfigPath);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
