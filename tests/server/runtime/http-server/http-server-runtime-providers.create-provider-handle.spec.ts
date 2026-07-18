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

describe('initializeProviderRuntimes provider.model direct scope', () => {
  function createRuntimeInitServer() {
    const handles = new Map<string, any>();
    const createProviderHandleMock = jest.fn(async (runtimeKey: string, runtime: any) => ({
      runtimeKey,
      providerId: runtime.providerId ?? runtimeKey.split('.')[0],
      providerType: runtime.providerType ?? 'responses',
      providerFamily: runtime.providerFamily ?? 'responses',
      providerProtocol: runtime.outboundProfile ?? 'openai-responses',
      runtime,
      instance: {
        initialize: async () => undefined,
        cleanup: async () => undefined,
        processIncoming: async () => ({}),
        processIncomingDirect: async () => ({}),
      },
    }));
    const server: any = {
      providerHandles: handles,
      providerKeyToRuntimeKey: new Map<string, string>(),
      providerRuntimeInitErrors: new Map<string, Error>(),
      runtimeKeyCredentialSkipped: new Set<string>(),
      startupExcludedProviderKeys: new Set<string>(),
      routingProviderScope: {
        providerKeys: ['cc.key1.gpt-5.5'],
        providerIds: ['cc'],
      },
      currentRouterArtifacts: null,
      materializeRuntimeProfile: async (runtime: any) => runtime,
      applyProviderProfileOverrides: (runtime: any) => runtime,
      createProviderHandle: createProviderHandleMock,
      disposeProviders: async () => undefined,
      getModuleDependencies: () => ({}),
    };
    return { server, createProviderHandleMock };
  }

  it('initializes provider.model direct target runtimes even when port route scope excludes them', async () => {
    jest.resetModules();
    const { initializeProviderRuntimes } = await import(
      '../../../../src/server/runtime/http-server/http-server-runtime-providers.js'
    );
    const { server, createProviderHandleMock } = createRuntimeInitServer();

    await initializeProviderRuntimes(server, {
      config: {},
      runtime: {},
      targetRuntime: {
        '1token.key1.gpt-5.5': {
          runtimeKey: '1token.key1',
          providerId: '1token',
          providerType: 'responses',
          providerFamily: 'responses',
          outboundProfile: 'openai-responses',
          endpoint: 'https://one.1token.xyz',
          auth: { type: 'apikey', value: 'test' },
        } as any,
      },
    });

    expect(createProviderHandleMock).toHaveBeenCalledTimes(1);
    expect(server.providerHandles.has('1token.key1')).toBe(true);
    expect(server.providerKeyToRuntimeKey.get('1token.key1.gpt-5.5')).toBe('1token.key1');
  });

  it('keeps non-target base runtimes filtered by routing scope', async () => {
    jest.resetModules();
    const { initializeProviderRuntimes } = await import(
      '../../../../src/server/runtime/http-server/http-server-runtime-providers.js'
    );
    const { server, createProviderHandleMock } = createRuntimeInitServer();

    await initializeProviderRuntimes(server, {
      config: {},
      runtime: {
        '1token.key1.gpt-5.5': {
          runtimeKey: '1token.key1',
          providerId: '1token',
          providerType: 'responses',
          providerFamily: 'responses',
          outboundProfile: 'openai-responses',
          endpoint: 'https://one.1token.xyz',
          auth: { type: 'apikey', value: 'test' },
        } as any,
      },
      targetRuntime: {},
    });

    expect(createProviderHandleMock).not.toHaveBeenCalled();
    expect(server.providerHandles.has('1token.key1')).toBe(false);
    expect(server.providerKeyToRuntimeKey.has('1token.key1.gpt-5.5')).toBe(false);
  });
});
