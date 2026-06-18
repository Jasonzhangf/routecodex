import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockReportProviderErrorToRouterPolicy = jest.fn(async () => undefined);
const mockReportProviderSuccessToRouterPolicy = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
  reportProviderErrorToRouterPolicy: mockReportProviderErrorToRouterPolicy,
  reportProviderSuccessToRouterPolicy: mockReportProviderSuccessToRouterPolicy
}));

const {
  buildRuntimeFromProviderContext,
  emitProviderError,
  emitProviderSuccessAndWait
} = await import('../../../../src/providers/core/utils/provider-error-reporter.js');

describe('provider-error-reporter', () => {
  beforeEach(() => {
    mockReportProviderErrorToRouterPolicy.mockReset();
    mockReportProviderErrorToRouterPolicy.mockResolvedValue(undefined);
    mockReportProviderSuccessToRouterPolicy.mockReset();
    mockReportProviderSuccessToRouterPolicy.mockResolvedValue(undefined);
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
        retryable: false,
        cooldownOverrideMs: 4321,
        quotaScope: 'weekly',
        quotaReason: 'weekly_exhausted'
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
        source: 'provider.send',
        errorClassification: 'recoverable',
        resetAt: '2026-05-28T00:00:00.000Z'
      }
    });

    expect(mockReportProviderErrorToRouterPolicy).toHaveBeenCalledWith(expect.objectContaining({
      code: 'HTTP_502',
      stage: 'provider.send',
      recoverable: true,
      affectsHealth: false,
      fatal: false,
      cooldownOverrideMs: 4321,
      quotaScope: 'weekly',
      quotaReason: 'weekly_exhausted',
      resetAt: '2026-05-28T00:00:00.000Z',
      errorClassification: 'recoverable',
      status: 502,
      runtime: expect.objectContaining({
        requestId: 'req-explicit-flags',
        providerKey: 'deepseek.key1.deepseek-v4-pro'
      })
    }));
  });

  it('forwards provider success to router policy', async () => {
    await emitProviderSuccessAndWait({
      requestId: 'req-success',
      providerKey: 'asxs.crsa.gpt-5.5',
      runtimeKey: 'asxs.crsa.gpt-5.5',
      routeName: 'thinking'
    });

    expect(mockReportProviderSuccessToRouterPolicy).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({
        requestId: 'req-success',
        providerKey: 'asxs.crsa.gpt-5.5',
        runtimeKey: 'asxs.crsa.gpt-5.5',
        routeName: 'thinking'
      }),
      timestamp: expect.any(Number)
    }));
  });

  it('projects request-scoped runtime paths from provider context for router policy ingress', () => {
    const runtime = buildRuntimeFromProviderContext({
      requestId: 'req-runtime-scope',
      providerKey: 'primary.key1.gpt-5.3-codex',
      providerId: 'primary',
      providerType: 'responses',
      providerProtocol: 'openai-responses',
      routeName: 'thinking',
      runtimeMetadata: {
        requestId: 'req-runtime-scope',
        providerKey: 'primary.key1.gpt-5.3-codex',
        __rt: {
          sessionDir: '/tmp/routecodex-session-port-scope',
          rccUserDir: '/tmp/routecodex-rcc-home'
        },
        metadata: {
          __rt: {
            sessionDir: '/tmp/wrong-nested-session',
            rccUserDir: '/tmp/wrong-nested-rcc'
          }
        }
      }
    } as never);

    expect(runtime).toEqual(expect.objectContaining({
      requestId: 'req-runtime-scope',
      providerKey: 'primary.key1.gpt-5.3-codex',
      sessionDir: '/tmp/routecodex-session-port-scope',
      rccUserDir: '/tmp/routecodex-rcc-home'
    }));
  });
});
