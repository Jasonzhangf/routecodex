import { describe, expect, it, jest } from '@jest/globals';

const initializeMock = jest.fn(async () => undefined);
const createProviderFromRuntimeMock = jest.fn(() => ({
  initialize: initializeMock
}));

jest.unstable_mockModule(
  '../../../../src/providers/core/runtime/provider-factory.js',
  () => ({
    ProviderFactory: {
      createProviderFromRuntime: createProviderFromRuntimeMock
    }
  })
);

describe('createProviderHandle protocol truth', () => {
  it('uses runtime outboundProfile as the only provider protocol truth', async () => {
    jest.resetModules();
    createProviderFromRuntimeMock.mockClear();
    initializeMock.mockClear();

    const { createProviderHandle } = await import(
      '../../../../src/server/runtime/http-server/http-server-runtime-providers.js'
    );

    const handle = await createProviderHandle(
      {
        getModuleDependencies: () => ({})
      },
      'provider.test',
      {
        runtimeKey: 'provider.test',
        providerId: 'provider',
        providerType: 'openai',
        providerFamily: 'glm',
        outboundProfile: 'openai-chat',
        endpoint: 'https://example.com',
        auth: { type: 'apikey', value: 'x' }
      } as any
    );

    expect(handle.providerProtocol).toBe('openai-chat');
    expect(createProviderFromRuntimeMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when runtime outboundProfile protocol truth is missing', async () => {
    jest.resetModules();
    createProviderFromRuntimeMock.mockClear();
    initializeMock.mockClear();

    const { createProviderHandle } = await import(
      '../../../../src/server/runtime/http-server/http-server-runtime-providers.js'
    );

    await expect(createProviderHandle(
      {
        getModuleDependencies: () => ({})
      },
      'provider.missing',
      {
        runtimeKey: 'provider.missing',
        providerId: 'provider',
        providerType: 'openai',
        providerFamily: 'glm',
        endpoint: 'https://example.com',
        auth: { type: 'apikey', value: 'x' }
      } as any
    )).rejects.toThrow('Provider runtime provider.missing is missing required outboundProfile protocol truth');

    expect(createProviderFromRuntimeMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
  });
});
