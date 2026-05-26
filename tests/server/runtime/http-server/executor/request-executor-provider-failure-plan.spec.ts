import { resolveRequestExecutorProviderFailurePlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure-plan';

describe('request-executor-provider-failure-plan', () => {
  test('does not force exclude current provider for special_400 provider.send failures when route pool is empty', async () => {
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(
        new Error('Converted provider tool call has invalid client arguments'),
        {
          code: 'CLIENT_TOOL_ARGS_INVALID',
          upstreamCode: 'CLIENT_TOOL_ARGS_INVALID',
          statusCode: 502
        }
      ),
      retryError: {
        statusCode: 502,
        errorCode: 'CLIENT_TOOL_ARGS_INVALID',
        upstreamCode: 'CLIENT_TOOL_ARGS_INVALID',
        reason: 'Converted provider tool call has invalid client arguments'
      },
      requestId: 'req-special-400-force-exclude',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      runtimeKey: 'runtime:mini27',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-special-400',
      logicalChainRetryLimitStageRequestId: 'logical-special-400',
      routePool: [],
      excludedProviderKeys: new Set<string>(),
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(false);
    expect(plan.retryExecutionPlan.shouldRetry).toBe(false);
  });

  test('does not force-exclude provider when route pool is unknown/empty', async () => {
    const excludedProviderKeys = new Set<string>();
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('provider runtime resolve failed'), {
        code: 'ERR_PROVIDER_NOT_FOUND',
        upstreamCode: 'ERR_PROVIDER_NOT_FOUND',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'ERR_PROVIDER_NOT_FOUND',
        upstreamCode: 'ERR_PROVIDER_NOT_FOUND',
        reason: 'provider runtime resolve failed'
      },
      requestId: 'req-empty-pool-no-force-exclude',
      providerKey: 'crs.crsa.gpt-5.4',
      runtimeKey: 'runtime:crs',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 3,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-empty-pool-no-force-exclude',
      logicalChainRetryLimitStageRequestId: 'logical-empty-pool-no-force-exclude',
      routePool: [],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(false);
    expect(excludedProviderKeys.size).toBe(0);
  });
});
