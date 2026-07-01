import { describe, expect, test, jest, beforeEach } from '@jest/globals';

const mockEmitProviderErrorAndWait = jest.fn();

jest.unstable_mockModule('../../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderErrorAndWait: mockEmitProviderErrorAndWait
}));

const { resolveRequestExecutorProviderFailurePlan } = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure-plan.js'
);
const { reportRequestExecutorProviderError } = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure.js'
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

  test('executor provider error report does not double count prior provider-runtime reported marker', async () => {
    const providerErrorReportedMarker = Symbol.for('routecodex.provider.errorReported');
    const error = Object.assign(new Error('upstream unavailable'), {
      code: 'HTTP_503',
      statusCode: 503,
      [providerErrorReportedMarker]: true
    });

    await reportRequestExecutorProviderError({
      error,
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        reason: 'upstream unavailable'
      },
      requestId: 'req-executor-reports-after-provider-runtime',
      providerKey: 'primary.key1.gpt-test',
      providerId: 'primary',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      routeName: 'thinking',
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      runtimeKey: 'primary.key1',
      target: { providerKey: 'primary.key1.gpt-test', runtimeKey: 'primary.key1' },
      dependencies: {} as any,
      attempt: 1,
      logStage: () => undefined,
      stageHint: 'provider.send',
      routePool: ['primary.key1.gpt-test', 'backup.key1.gpt-test'],
      excludedProviderKeys: new Set<string>()
    });

    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  test('executor provider error report marks original error to avoid duplicate health strikes', async () => {
    const error = Object.assign(new Error('upstream unavailable'), {
      code: 'HTTP_503',
      statusCode: 503
    });
    const baseArgs = {
      error,
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        reason: 'upstream unavailable'
      },
      requestId: 'req-executor-duplicate-provider-send',
      providerKey: 'primary.key1.gpt-test',
      providerId: 'primary',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      routeName: 'thinking',
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      runtimeKey: 'primary.key1',
      target: { providerKey: 'primary.key1.gpt-test', runtimeKey: 'primary.key1' },
      dependencies: {} as any,
      attempt: 1,
      logStage: () => undefined,
      stageHint: 'provider.send' as const,
      routePool: ['primary.key1.gpt-test', 'backup.key1.gpt-test'],
      excludedProviderKeys: new Set<string>()
    };

    await reportRequestExecutorProviderError(baseArgs);
    await reportRequestExecutorProviderError(baseArgs);

    expect(mockEmitProviderErrorAndWait).toHaveBeenCalledTimes(1);
  });
});
