import { ProviderFactory } from '../../src/modules/pipeline/modules/provider/v2/core/provider-factory.js';

describe('ProviderFactory no fallback', () => {
  test('unknown providerType/moduleType throws', () => {
    const cfg: any = { type: 'unknown-x', config: { providerType: 'unknown-y', auth: { type: 'apikey', apiKey: 'x' } } };
    expect(() => ProviderFactory.createProvider(cfg, { logger: {} as any } as any)).toThrow();
  });
});
jest.mock('../../src/modules/pipeline/modules/provider/v2/utils/snapshot-writer.ts', () => ({
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
