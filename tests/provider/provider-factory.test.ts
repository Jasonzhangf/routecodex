import { describe, expect, test, jest } from '@jest/globals';
import { ProviderFactory } from '../../src/providers/core/runtime/provider-factory.js';

describe('ProviderFactory no fallback', () => {
  test('unknown providerType/moduleType throws', () => {
    const cfg: any = { type: 'unknown-x', config: { providerType: 'unknown-y', auth: { type: 'apikey', apiKey: 'x' } } };
    expect(() => ProviderFactory.createProvider(cfg, { logger: {} as any } as any)).toThrow();
  });

  test('runtime timeoutMs/maxRetries map into provider config', () => {
    const runtime: any = {
      runtimeKey: 'nvidia.key1',
      providerId: 'nvidia',
      providerType: 'openai',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      auth: { type: 'apikey', value: '12345678901' },
      timeoutMs: 900000,
      maxRetries: 7
    };
    const provider = ProviderFactory.createProviderFromRuntime(runtime, { logger: {} as any } as any) as any;
    expect(provider?.config?.config?.timeout).toBe(900000);
    expect(provider?.config?.config?.maxRetries).toBe(7);
  });
});
jest.mock('../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot: async () => {}
}), { virtual: true });
jest.mock('../../src/modules/llmswitch/bridge.ts', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  extractSessionIdentifiersFromMetadata: () => ({}),
  extractAntigravityGeminiSessionId: () => undefined,
  cacheAntigravitySessionSignature: () => {},
  lookupAntigravitySessionSignatureEntry: () => undefined,
  getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
  resetAntigravitySessionSignatureCachesForTests: () => {},
  warmupAntigravitySessionSignatureModule: async () => {},
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  buildResponsesRequestFromChat: () => ({ request: {} }),
  buildChatResponseFromResponses: () => ({ choices: [] })
}), { virtual: true });
jest.mock('../../src/modules/llmswitch/bridge.js', () => ({
  getStatsCenterSafe: () => ({ recordProviderUsage: () => {} }),
  extractSessionIdentifiersFromMetadata: () => ({}),
  extractAntigravityGeminiSessionId: () => undefined,
  cacheAntigravitySessionSignature: () => {},
  lookupAntigravitySessionSignatureEntry: () => undefined,
  getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
  resetAntigravitySessionSignatureCachesForTests: () => {},
  warmupAntigravitySessionSignatureModule: async () => {},
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  buildResponsesRequestFromChat: () => ({ request: {} }),
  buildChatResponseFromResponses: () => ({ choices: [] })
}), { virtual: true });
