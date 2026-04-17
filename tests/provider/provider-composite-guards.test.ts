import { describe, expect, test, jest } from '@jest/globals';

describe('Provider error reporting', () => {
  test('emitProviderError reports ProviderErrorEvent to router policy and does not rely on errorHandlingCenter fallback', async () => {
    jest.resetModules();

    const reportProviderErrorToRouterPolicy = jest.fn(async (event) => event);
    await jest.unstable_mockModule('../../src/modules/llmswitch/bridge.ts', () => ({
      reportProviderErrorToRouterPolicy,
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

    expect(reportProviderErrorToRouterPolicy).toHaveBeenCalled();
    expect(deps.errorHandlingCenter.handleError).not.toHaveBeenCalled();
  });

  test('emitProviderError honors explicit affectsHealth=false even for non-recoverable errors', async () => {
    jest.resetModules();

    const reportProviderErrorToRouterPolicy = jest.fn(async (event) => event);
    await jest.unstable_mockModule('../../src/modules/llmswitch/bridge.ts', () => ({
      reportProviderErrorToRouterPolicy,
      extractAntigravityGeminiSessionId: () => undefined,
      cacheAntigravitySessionSignature: () => {},
      lookupAntigravitySessionSignatureEntry: () => undefined,
      getAntigravityLatestSignatureSessionIdForAlias: () => undefined,
      resetAntigravitySessionSignatureCachesForTests: () => {},
      warmupAntigravitySessionSignatureModule: async () => {}
    }));

    const { emitProviderError } = await import('../../src/providers/core/utils/provider-error-reporter.ts');

    emitProviderError({
      error: Object.assign(new Error('followup payload missing'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        statusCode: 502,
        retryable: false,
        category: 'INTERNAL_ERROR'
      }),
      stage: 'provider.followup',
      runtime: {
        requestId: 'req_followup_internal',
        providerType: 'openai',
        providerProtocol: 'openai-chat',
        providerId: 'test-provider',
        providerKey: 'openai.test',
        routeName: 'test-route'
      },
      dependencies: {} as any,
      recoverable: false,
      affectsHealth: false
    });

    expect(reportProviderErrorToRouterPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.followup',
        recoverable: false,
        affectsHealth: false
      })
    );
  });
});
