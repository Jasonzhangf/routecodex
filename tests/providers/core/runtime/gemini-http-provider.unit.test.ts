import { GeminiHttpProvider } from '../../../../src/providers/core/runtime/gemini-http-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/providers/modules/pipeline/interfaces/pipeline-interfaces.js';

const oauthConfig: OpenAIStandardConfig = {
  id: 'test-gemini',
  config: {
    providerType: 'gemini',
    auth: {
      type: 'gemini-oauth',
      apiKey: ''
    }
  }
} as unknown as OpenAIStandardConfig;

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

describe('GeminiHttpProvider auth validation', () => {
  test('accepts gemini-oauth auth type via service profile', () => {
    const provider = new GeminiHttpProvider(oauthConfig, emptyDeps);
    expect(provider).toBeTruthy();
    const profile = (provider as any).serviceProfile;
    expect(profile.requiredAuth).toEqual([]);
    expect(profile.optionalAuth).toContain('oauth');
  });

  test('postprocessResponse preserves object payloads and wraps primitive payloads', async () => {
    const provider = new GeminiHttpProvider(oauthConfig, emptyDeps);
    const context = {} as any;

    await expect((provider as any).postprocessResponse({ ok: true }, context)).resolves.toEqual({ ok: true });
    await expect((provider as any).postprocessResponse('plain-text', context)).resolves.toEqual({ data: 'plain-text' });
  });
});
