import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockReportProviderErrorToRouterPolicy = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  reportProviderErrorToRouterPolicy: mockReportProviderErrorToRouterPolicy
}));

const { emitProviderError } = await import('../../../../src/providers/core/utils/provider-error-reporter.js');

describe('provider-error-reporter', () => {
  beforeEach(() => {
    mockReportProviderErrorToRouterPolicy.mockReset();
    mockReportProviderErrorToRouterPolicy.mockResolvedValue(undefined);
  });

  it('requires explicit recoverable and affectsHealth flags', () => {
    expect(() => emitProviderError({
      error: new Error('missing policy flags'),
      stage: 'provider.http',
      runtime: {
        requestId: 'req-missing-flags',
        providerKey: 'deepseek.key1.deepseek-v4-pro'
      },
      dependencies: {} as never
    } as never)).toThrow('[provider-error-reporter] explicit recoverable/affectsHealth is required');
  });

  it('forwards explicit policy flags without fallback guessing', async () => {
    emitProviderError({
      error: Object.assign(new Error('fetch failed'), {
        code: 'HTTP_502',
        retryable: false
      }),
      stage: 'provider.send',
      runtime: {
        requestId: 'req-explicit-flags',
        providerKey: 'deepseek.key1.deepseek-v4-pro'
      },
      dependencies: {} as never,
      recoverable: true,
      affectsHealth: false,
      statusCode: 502,
      details: {
        source: 'provider.send'
      }
    });

    expect(mockReportProviderErrorToRouterPolicy).toHaveBeenCalledWith(expect.objectContaining({
      code: 'HTTP_502',
      stage: 'provider.send',
      recoverable: true,
      affectsHealth: false,
      status: 502,
      runtime: expect.objectContaining({
        requestId: 'req-explicit-flags',
        providerKey: 'deepseek.key1.deepseek-v4-pro'
      })
    }));
  });
});
