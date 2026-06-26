import { resolveRequestExecutorProviderFailurePlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure-plan';

describe('request-executor-provider-failure-plan', () => {
  test('local CLIENT_TOOL_ARGS_INVALID conversion failures no longer classify as special_400 but still suppress force-exclude', async () => {
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
      forceExcludeCurrentProviderOnRetry: true,
      excludedProviderKeys: new Set<string>(),
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(false);
    expect(plan.retryExecutionPlan.shouldRetry).toBe(false);
    expect(plan.reportPlan.stageHint).toBe('provider.send');
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

  test('provider business error 2013 traffic saturation immediately excludes current provider and reroutes', async () => {
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
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(true);
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
  });

  test('real provider business error 2013 traffic saturation reroutes when route pool still has alternatives', async () => {
    const excludedProviderKeys = new Set<string>();
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(
        new Error('Token Plan 当前请求量较高，请稍后重试'),
        {
          code: 'MALFORMED_RESPONSE',
          upstreamCode: 'PROVIDER_STATUS_2013',
          statusCode: 200,
          details: {
            providerStatusCode: 2013,
            upstreamCode: 'PROVIDER_STATUS_2013',
            reason: 'token plan 当前请求量较高，请稍后重试'
          }
        }
      ),
      retryError: {
        statusCode: 200,
        errorCode: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2013',
        reason: 'Token Plan 当前请求量较高，请稍后重试'
      },
      requestId: 'req-special-400-reroute',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      runtimeKey: 'runtime:mini27',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-special-400-reroute',
      logicalChainRetryLimitStageRequestId: 'logical-special-400-reroute',
      routePool: ['mini27.key1.MiniMax-M2.7', 'minimax.key1.MiniMax-M3'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(true);
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(excludedProviderKeys.has('mini27.key1.MiniMax-M2.7')).toBe(true);
  });

  test('RED: defaultTierAvailable true must flow into ErrorErr05 and block client projection when route pool is exhausted', async () => {
    const excludedProviderKeys = new Set<string>(['p1']);
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('Upstream authentication failed'), {
        code: 'HTTP_401',
        upstreamCode: 'HTTP_401',
        statusCode: 401
      }),
      retryError: {
        statusCode: 401,
        errorCode: 'HTTP_401',
        upstreamCode: 'HTTP_401',
        reason: 'Upstream authentication failed'
      },
      requestId: 'req-default-tier-available-blocks-projection',
      providerKey: 'p1',
      runtimeKey: 'runtime:p1',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-default-tier-available-blocks-projection',
      logicalChainRetryLimitStageRequestId: 'logical-default-tier-available-blocks-projection',
      routePool: ['p1'],
      defaultTierAvailable: true,
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.retryExecutionPlan.routePoolRemainingAfterExclusion).toEqual([]);
    expect(plan.retryExecutionPlan.defaultPoolAvailable).toBe(true);
    expect(plan.retryExecutionPlan.policyExhausted).toBe(false);
    expect(plan.retryExecutionPlan.mayProject).toBe(false);
  });

  test('provider-configured 400->429 mapping must exclude current provider and reroute', async () => {
    const excludedProviderKeys = new Set<string>();
    const mappedError = Object.assign(
      new Error('All available accounts exhausted'),
      {
        code: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        statusCode: 429,
        status: 429,
        response: {
          data: {
            error: {
              code: 'HTTP_429',
              message: 'All available accounts exhausted',
              status: 429,
              type: 'server_error'
            }
          }
        },
        details: {
          providerErrorMapping: {
            originalStatus: 400,
            originalCode: 'HTTP_400',
            originalMessage: 'HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error"}}',
            mappedStatus: 429,
            mappedCode: 'HTTP_429'
          }
        }
      }
    );

    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: mappedError,
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        reason: 'All available accounts exhausted'
      },
      requestId: 'req-provider-configured-error-mapping',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      providerId: 'XLC',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      runtimeKey: 'XLC.key2',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-provider-configured-error-mapping',
      logicalChainRetryLimitStageRequestId: 'logical-provider-configured-error-mapping',
      routePool: ['XLC.key2.deepseek-v4-pro', 'minimax.key1.MiniMax-M3'],
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.reportPlan.statusCode).toBe(429);
    expect(plan.reportPlan.errorCode).toBe('HTTP_429');
    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(true);
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(excludedProviderKeys.has('XLC.key2.deepseek-v4-pro')).toBe(true);
  });

  test('single-provider retry path does not synthesize same-provider retry state', async () => {
    const excludedProviderKeys = new Set<string>();
    const plan = await resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('HTTP 525: upstream SSL handshake failed'), {
        code: 'HTTP_525',
        upstreamCode: 'HTTP_525',
        statusCode: 525
      }),
      retryError: {
        statusCode: 525,
        errorCode: 'HTTP_525',
        upstreamCode: 'HTTP_525',
        reason: 'HTTP 525: upstream SSL handshake failed'
      },
      requestId: 'req-same-provider-rotate-apikey',
      providerKey: 'asxs.gpt-5.4',
      runtimeKey: 'runtime:asxs',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-same-provider-rotate-apikey',
      logicalChainRetryLimitStageRequestId: 'logical-same-provider-rotate-apikey',
      routePool: ['asxs.gpt-5.4'],
      excludedProviderKeys,
      isStreamingRequest: false,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.requestLocalProviderRetryState).toBeUndefined();
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
  });
});
