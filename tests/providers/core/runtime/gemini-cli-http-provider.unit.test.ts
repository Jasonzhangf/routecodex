import { GeminiCLIHttpProvider } from '../../../../src/providers/core/runtime/gemini-cli-http-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/providers/modules/pipeline/interfaces/pipeline-interfaces.js';

const baseConfig: OpenAIStandardConfig = {
  id: 'test-gemini-cli',
  config: {
    providerType: 'gemini-cli',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    endpoint: '/v1internal:generateContent',
    auth: {
      type: 'gemini-cli-oauth',
      apiKey: ''
    }
  }
} as unknown as OpenAIStandardConfig;

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;

describe('GeminiCLIHttpProvider basic behaviour', () => {
  test('constructs and exposes service profile from config-core', () => {
    const provider = new GeminiCLIHttpProvider(baseConfig, emptyDeps);

    // getConfig() should reflect injected config, service profile should come from service-profiles
    const cfg = provider.getConfig() as Record<string, unknown>;
    expect(cfg).toBeTruthy();

    const profile = (provider as any).serviceProfile;
    expect(profile).toBeTruthy();
    expect(profile.defaultBaseUrl).toContain('cloudcode-pa.googleapis.com');
    expect(profile.defaultEndpoint).toContain('v1internal:generateContent');
    expect(profile.requiredAuth).toContain('oauth');
  });
});
