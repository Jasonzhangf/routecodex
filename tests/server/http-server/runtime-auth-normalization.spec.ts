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
      runtimeKey: 'iflow.1-186',
      providerId: 'iflow',
      providerType: 'openai',
      endpoint: 'https://apis.iflow.cn/v1',
      auth: {
        type: 'iflow-oauth',
        tokenFile: '~/.routecodex/auth/iflow-oauth-1-186.json'
      }
    } as unknown as ProviderRuntimeProfile;

    const resolved = await resolveRuntimeAuth(createServerStub(), runtime);

    expect(resolved.type).toBe('oauth');
    expect(resolved.rawType).toBe('iflow-oauth');
    expect(resolved.oauthProviderId).toBe('iflow');
    expect(resolved.tokenFile).toBe('~/.routecodex/auth/iflow-oauth-1-186.json');
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
