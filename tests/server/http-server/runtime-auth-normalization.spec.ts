import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeAuth } from '../../../src/server/runtime/http-server/http-server-runtime-providers.js';
import type { ProviderRuntimeProfile } from '../../../src/providers/core/api/provider-types.js';

function createServerStub(): {
  normalizeAuthType: (input: unknown) => 'apikey' | 'oauth';
  resolveSecretValue: (raw: string) => Promise<string>;
  resolveApiKeyValue: () => Promise<string>;
} {
  return {
    normalizeAuthType: (input: unknown) =>
      typeof input === 'string' && input.toLowerCase().includes('oauth') ? 'oauth' : 'apikey',
    resolveSecretValue: async (raw: string) => raw,
    resolveApiKeyValue: async () => ''
  };
}

describe('resolveRuntimeAuth oauth identity normalization', () => {
  it('preserves rawType from auth.type and derives oauthProviderId for provider-specific oauth types', async () => {
    const runtime = {
      runtimeKey: 'glm.1-186',
      providerId: 'glm',
      providerType: 'openai',
      endpoint: 'https://api.glm.com/v1',
      auth: {
        type: 'glm-oauth',
        tokenFile: '~/.routecodex/auth/glm-oauth-1-186.json'
      }
    } as unknown as ProviderRuntimeProfile;

    const resolved = await resolveRuntimeAuth(createServerStub(), runtime);

    expect(resolved.type).toBe('oauth');
    expect(resolved.rawType).toBe('glm-oauth');
    expect(resolved.oauthProviderId).toBe('glm');
    expect(resolved.tokenFile).toBe('~/.routecodex/auth/glm-oauth-1-186.json');
  });

  it('falls back to runtime.providerId when auth type is generic oauth', async () => {
    const runtime = {
      runtimeKey: 'qwen.default',
      providerId: 'qwen',
      providerType: 'openai',
      endpoint: 'https://chat.qwen.ai',
      auth: {
        type: 'oauth'
      }
    } as unknown as ProviderRuntimeProfile;

    const resolved = await resolveRuntimeAuth(createServerStub(), runtime);

    expect(resolved.type).toBe('oauth');
    expect(resolved.rawType).toBe('oauth');
    expect(resolved.oauthProviderId).toBe('qwen');
  });
});

describe('resolveRuntimeAuth deepseek-account tokenFile compatibility', () => {
  const originalHome = process.env.HOME;
  const originalRccHome = process.env.RCC_HOME;
  const originalRouteCodexUserDir = process.env.ROUTECODEX_USER_DIR;
  const originalRouteCodexHome = process.env.ROUTECODEX_HOME;

  afterEach(() => {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (typeof originalRccHome === 'string') {
      process.env.RCC_HOME = originalRccHome;
    } else {
      delete process.env.RCC_HOME;
    }
    if (typeof originalRouteCodexUserDir === 'string') {
      process.env.ROUTECODEX_USER_DIR = originalRouteCodexUserDir;
    } else {
      delete process.env.ROUTECODEX_USER_DIR;
    }
    if (typeof originalRouteCodexHome === 'string') {
      process.env.ROUTECODEX_HOME = originalRouteCodexHome;
    } else {
      delete process.env.ROUTECODEX_HOME;
    }
  });

  it('remaps legacy ~/.routecodex/auth tokenFile to ~/.rcc/auth when legacy file is missing', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-runtime-auth-deepseek-'));
    process.env.HOME = home;
    process.env.RCC_HOME = path.join(home, '.rcc');
    process.env.ROUTECODEX_USER_DIR = path.join(home, '.rcc');
    process.env.ROUTECODEX_HOME = path.join(home, '.rcc');

    const rccAuthDir = path.join(home, '.rcc', 'auth');
    const rccTokenFile = path.join(rccAuthDir, 'deepseek-account-1.json');
    await fs.mkdir(rccAuthDir, { recursive: true });
    await fs.writeFile(rccTokenFile, JSON.stringify({ access_token: 'token-from-rcc' }) + '\n', 'utf8');

    const runtime = {
      runtimeKey: 'deepseek-web.1',
      providerId: 'deepseek-web',
      providerType: 'openai',
      endpoint: 'https://chat.deepseek.com/api/v0',
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        tokenFile: '~/.routecodex/auth/deepseek-account-1.json'
      }
    } as unknown as ProviderRuntimeProfile;

    const resolved = await resolveRuntimeAuth(createServerStub(), runtime);
    expect(resolved.type).toBe('apikey');
    expect(resolved.tokenFile).toBe(rccTokenFile);
  });

  it('remaps legacy tokenFile when legacy file exists but contains unusable placeholder payload', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-runtime-auth-deepseek-'));
    process.env.HOME = home;
    process.env.RCC_HOME = path.join(home, '.rcc');
    process.env.ROUTECODEX_USER_DIR = path.join(home, '.rcc');
    process.env.ROUTECODEX_HOME = path.join(home, '.rcc');

    const legacyAuthDir = path.join(home, '.routecodex', 'auth');
    const legacyTokenFile = path.join(legacyAuthDir, 'deepseek-account-2.json');
    const rccAuthDir = path.join(home, '.rcc', 'auth');
    const rccTokenFile = path.join(rccAuthDir, 'deepseek-account-2.json');

    await fs.mkdir(legacyAuthDir, { recursive: true });
    await fs.mkdir(rccAuthDir, { recursive: true });
    await fs.writeFile(legacyTokenFile, '{}\n', 'utf8');
    await fs.writeFile(rccTokenFile, JSON.stringify({ access_token: 'token-from-rcc' }) + '\n', 'utf8');

    const runtime = {
      runtimeKey: 'deepseek-web.2',
      providerId: 'deepseek-web',
      providerType: 'openai',
      endpoint: 'https://chat.deepseek.com/api/v0',
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        tokenFile: '~/.routecodex/auth/deepseek-account-2.json'
      }
    } as unknown as ProviderRuntimeProfile;

    const resolved = await resolveRuntimeAuth(createServerStub(), runtime);
    expect(resolved.type).toBe('apikey');
    expect(resolved.tokenFile).toBe(rccTokenFile);
  });
});
