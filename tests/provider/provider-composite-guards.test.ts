import { ProviderComposite } from '../../src/modules/pipeline/modules/provider/v2/composite/provider-composite.js';
import { attachProviderRuntimeMetadata } from '../../src/modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.ts';

jest.mock('@jsonstudio/llms/dist/router/virtual-router/error-center.js', () => ({
  providerErrorCenter: { emit: jest.fn() }
}), { virtual: true });

jest.mock('@jsonstudio/llms/dist/router/virtual-router/types.js', () => ({}), { virtual: true });

const mockDeps = () => ({ errorHandlingCenter: { handleError: jest.fn(async () => {}) } } as any);

describe('ProviderComposite guards → Error Center', () => {
  test('protocol mismatch triggers handleError and throws', async () => {
    const deps = mockDeps();
    const body: any = { data: { model: 'gpt', messages: [] } };
    attachProviderRuntimeMetadata(body, { requestId: 'req_x', providerType: 'anthropic', providerProtocol: 'openai-chat', providerKey: 'k1' });
    await expect(ProviderComposite.applyRequest(body, { providerType: 'anthropic', dependencies: deps })).rejects.toThrow();
    expect(deps.errorHandlingCenter.handleError).toHaveBeenCalled();
  });
});
