import { GeminiHttpProvider } from '../../../../src/providers/core/runtime/gemini-http-provider.js';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/providers/modules/pipeline/interfaces/pipeline-interfaces.js';
import { createHash } from 'node:crypto';
import {
  resetAntigravitySessionSignatureCachesForTests,
  warmupAntigravitySessionSignatureModule
} from '../../../../src/modules/llmswitch/bridge.js';

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

function stableSid(raw: string): string {
  return `sid-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

describe('GeminiHttpProvider auth validation', () => {
  test('accepts gemini-oauth auth type via service profile', () => {
    const provider = new GeminiHttpProvider(oauthConfig, emptyDeps);
    expect(provider).toBeTruthy();
    const profile = (provider as any).serviceProfile;
    expect(profile.requiredAuth).toEqual([]);
    expect(profile.optionalAuth).toContain('oauth');
  });
});

describe('GeminiHttpProvider antigravity compat', () => {
  test('derives antigravitySessionId from first user message (ignores metadata.sessionId)', async () => {
    await warmupAntigravitySessionSignatureModule();
    resetAntigravitySessionSignatureCachesForTests();

    const cfg: OpenAIStandardConfig = {
      ...oauthConfig,
      config: {
        ...(oauthConfig.config as any),
        providerId: 'antigravity'
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new GeminiHttpProvider(cfg, emptyDeps);
    (provider as any).lastRuntimeMetadata = {
      runtimeKey: 'antigravity.sessionDerive',
      providerKey: 'antigravity.sessionDerive.gemini-3-pro-high',
      providerId: 'antigravity'
    };

    const seedText = 'session seed: provider should derive session id from user text parts';
    const expectedDerived = stableSid(seedText);

    const processed = await (provider as any).preprocessRequest({
      model: 'models/gemini-pro',
      contents: [{ role: 'user', parts: [{ text: seedText }] }],
      metadata: { sessionId: 'external-session-id' },
      stream: true
    });

    expect((processed as any)?.metadata?.antigravitySessionId).toBe(expectedDerived);
    expect((processed as any)?.metadata?.antigravitySessionIdOriginal).toBeUndefined();
  });
});
