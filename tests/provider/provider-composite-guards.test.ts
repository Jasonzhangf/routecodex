import { describe, expect, test, jest } from '@jest/globals';

describe('Provider error reporting', () => {
  test('emitProviderError emits ProviderErrorEvent and calls errorHandlingCenter', async () => {
    jest.resetModules();

    const providerErrorEmit = jest.fn();
    await jest.unstable_mockModule('../../src/modules/llmswitch/bridge.ts', () => ({
      getProviderErrorCenter: async () => ({ emit: providerErrorEmit }),
      extractAntigravityGeminiSessionId: () => undefined,
      cacheAntigravitySessionSignature: () => {},
      lookupAntigravitySessionSignatureEntry: () => undefined,
      getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
      resetAntigravitySessionSignatureCachesForTests: () => {},
      warmupAntigravitySessionSignatureModule: async () => {}
    }));
    await jest.unstable_mockModule('../../src/error-handling/route-error-hub.ts', () => ({
      getRouteErrorHub: () => null,
      reportRouteError: jest.fn(async () => ({}))
    }));

    const { emitProviderError } = await import('../../src/providers/core/utils/provider-error-reporter.ts');

    const deps = {
      errorHandlingCenter: { handleError: jest.fn(async () => {}) }
    } as any;

    emitProviderError({
      error: new Error('boom'),
      stage: 'provider-test',
      runtime: {
        requestId: 'req_x',
        providerType: 'openai',
        providerProtocol: 'openai-chat',
        providerId: 'test-provider',
        providerKey: 'openai.test',
        routeName: 'test-route'
      },
      dependencies: deps
    });

    expect(providerErrorEmit).toHaveBeenCalled();
    expect(deps.errorHandlingCenter.handleError).toHaveBeenCalled();
  });
});
