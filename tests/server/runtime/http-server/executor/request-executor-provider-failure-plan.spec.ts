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

  test('RED: provider business error 2013 traffic saturation must enter retry/cooldown plan, not direct return to client', async () => {
    const excludedProviderKeys = new Set<string>();
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('Token Plan 当前请求量较高，请稍后重试'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2013',
        statusCode: 200,
        details: {
          providerStatusCode: 2013,
          upstreamCode: 'PROVIDER_STATUS_2013',
          reason: 'token plan 当前请求量较高，请稍后重试'
        }
      }),
      retryError: {
        statusCode: 200,
        errorCode: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2013',
        reason: 'Token Plan 当前请求量较高，请稍后重试'
      },
      requestId: 'req-provider-status-2013-traffic',
      providerKey: 'minimax.key1.MiniMax-M3',
      providerId: 'minimax',
      providerType: 'openai',
      providerFamily: 'minimax',
      providerProtocol: 'openai-responses',
      runtimeKey: 'runtime:minimax',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-provider-status-2013-traffic',
      logicalChainRetryLimitStageRequestId: 'logical-provider-status-2013-traffic',
      routePool: ['minimax.key1.MiniMax-M3', 'opencode-zen-free.key1.minimax-m3-free'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.reportPlan.stageHint).toBe('provider.send');
    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(plan.retryExecutionPlan.backoffScope).toBe('recoverable');
  });
});
