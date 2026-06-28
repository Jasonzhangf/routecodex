import { resolveRuntimeAuth } from '../../../src/server/runtime/http-server/http-server-runtime-providers.js';
import type { ProviderRuntimeProfile } from '../../../src/providers/core/api/provider-types.js';

function createServerStub(): {
  normalizeAuthType: (input: unknown) => 'apikey';
  resolveSecretValue: (raw: string) => Promise<string>;
  resolveApiKeyValue: (_runtime: ProviderRuntimeProfile, auth: ProviderRuntimeProfile['auth']) => Promise<string>;
} {
  return {
    normalizeAuthType: (input: unknown) => {
      if (typeof input === 'string' && input.toLowerCase().includes('oauth')) {
        throw new Error('OAuth auth has been removed; use auth.type="apikey"');
      }
      return 'apikey';
    },
    resolveSecretValue: async (raw: string) => raw,
    resolveApiKeyValue: async (_runtime, auth) => auth?.value ?? 'sk-test'
  };
}

describe('resolveRuntimeAuth API-key-only auth normalization', () => {
  it('rejects removed oauth auth types', async () => {
    const runtime = {
      runtimeKey: 'glm.1',
      providerId: 'glm',
      providerType: 'openai',
      endpoint: 'https://api.glm.example/v1',
      auth: { type: 'glm-oauth' }
    } as unknown as ProviderRuntimeProfile;

    await expect(resolveRuntimeAuth(createServerStub(), runtime)).rejects.toThrow(/OAuth auth has been removed/);
  });

  it('rejects removed account raw auth types', async () => {
    const runtime = {
      runtimeKey: 'demo-web.1',
      providerId: 'demo-web',
      providerType: 'openai',
      endpoint: 'https://api.example.com/v1',
      auth: {
        type: 'apikey',
        rawType: 'deepseek-account',
        tokenFile: '~/.routecodex/auth/deepseek-account-1.json'
      }
    } as unknown as ProviderRuntimeProfile;

    await expect(resolveRuntimeAuth(createServerStub(), runtime)).rejects.toThrow(/deepseek-account auth has been removed/);
  });
});
