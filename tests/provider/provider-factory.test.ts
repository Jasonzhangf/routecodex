import { describe, expect, test, jest } from '@jest/globals';
import { ProviderFactory } from '../../src/providers/core/runtime/provider-factory.js';

describe('ProviderFactory no fallback', () => {
  test('unknown providerType/moduleType throws', () => {
    const cfg: any = { type: 'unknown-x', config: { providerType: 'unknown-y', auth: { type: 'apikey', apiKey: 'x' } } };
    expect(() => ProviderFactory.createProvider(cfg, { logger: {} as any } as any)).toThrow();
  });
});
jest.mock('../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot: async () => {}
}), { virtual: true });
jest.mock('../../src/modules/llmswitch/bridge.ts', () => ({
  buildResponsesRequestFromChat: () => ({ request: {} }),
  buildChatResponseFromResponses: () => ({ choices: [] })
}), { virtual: true });
jest.mock('../../src/modules/llmswitch/bridge.js', () => ({
  buildResponsesRequestFromChat: () => ({ request: {} }),
  buildChatResponseFromResponses: () => ({ choices: [] })
}), { virtual: true });
