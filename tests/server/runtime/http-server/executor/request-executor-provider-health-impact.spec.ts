import { describe, expect, test, jest, beforeEach } from '@jest/globals';

const mockEmitProviderErrorAndWait = jest.fn();

jest.unstable_mockModule('../../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderErrorAndWait: mockEmitProviderErrorAndWait
}));

const { resolveRequestExecutorProviderFailurePlan } = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure-plan.js'
);

describe('request-executor provider health impact', () => {
  beforeEach(() => {
    mockEmitProviderErrorAndWait.mockReset();
  });

  test('pool alternative reroute passes routePool and excludedProviderKeys for Rust VR policy', async () => {
    const excludedProviderKeys = new Set<string>();

    await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('upstream bad gateway'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'upstream bad gateway'
      },
      requestId: 'req-pool-alternative-health-impact',
      providerKey: 'provider.a',
      providerId: 'provider-a',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtimeKey: 'runtime:provider-a',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 3,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-pool-alternative-health-impact',
      logicalChainRetryLimitStageRequestId: 'logical-pool-alternative-health-impact',
      routePool: ['provider.a', 'provider.b'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.send',
        recoverable: true,
        affectsHealth: true,
        routePool: ['provider.a', 'provider.b'],
        runtime: expect.objectContaining({
          requestId: 'req-pool-alternative-health-impact',
          providerKey: 'provider.a'
        })
      })
    );
  });

  test('singleton pool recoverable failure passes routePool with no alternative', async () => {
    const excludedProviderKeys = new Set<string>();

    await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('upstream bad gateway'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'upstream bad gateway'
      },
      requestId: 'req-singleton-health-impact',
      providerKey: 'provider.a',
      providerId: 'provider-a',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtimeKey: 'runtime:provider-a',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 3,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-singleton-health-impact',
      logicalChainRetryLimitStageRequestId: 'logical-singleton-health-impact',
      routePool: ['provider.a'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.send',
        recoverable: true,
        affectsHealth: true,
        routePool: ['provider.a'],
        runtime: expect.objectContaining({
          requestId: 'req-singleton-health-impact',
          providerKey: 'provider.a'
        })
      })
    );
  });

  test('provider error report forwards explicit routing policy group without metadata fallback', async () => {
    const excludedProviderKeys = new Set<string>();

    await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('upstream unavailable'), {
        code: 'HTTP_503',
        statusCode: 503
      }),
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        reason: 'upstream unavailable'
      },
      requestId: 'req-routing-policy-group-health-impact',
      providerKey: 'primary.key1.gpt-test',
      providerId: 'primary',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      routeName: 'thinking',
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      runtimeKey: 'primary.key1',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 3,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-routing-policy-group-health-impact',
      logicalChainRetryLimitStageRequestId: 'logical-routing-policy-group-health-impact',
      routePool: ['primary.key1.gpt-test', 'backup.key1.gpt-test'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.send',
        runtime: expect.objectContaining({
          providerKey: 'primary.key1.gpt-test',
          routecodexRoutingPolicyGroup: 'gateway_priority_5555'
        })
      })
    );
  });
});
