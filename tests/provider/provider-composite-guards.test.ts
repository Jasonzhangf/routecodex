import { describe, expect, test, jest } from '@jest/globals';
import { ProviderComposite } from '../../src/providers/core/composite/provider-composite.js';
import { attachProviderRuntimeMetadata } from '../../src/providers/core/runtime/provider-runtime-metadata.ts';

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
