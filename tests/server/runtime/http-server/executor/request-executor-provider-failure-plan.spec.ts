import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { resolveRequestExecutorProviderFailurePlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure-plan';
import {
  registerErrorActionQueueHook,
  resetErrorActionQueueStateForTests
} from '../../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue';

describe('request-executor-provider-failure-plan', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetErrorActionQueueStateForTests();
  });

  test('protocol boundary conflicts never exclude providers from VR route hits', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(
      new Error('MetadataCenter runtime_control.providerProtocol conflict: existing=openai-responses selected=anthropic-messages'),
      {
        code: 'ERR_PROVIDER_PROTOCOL_MISMATCH'
      }
    );

    const plan = await resolveRequestExecutorProviderFailurePlan({
      error,
      retryError: {
        errorCode: 'ERR_PROVIDER_PROTOCOL_MISMATCH',
        reason: 'MetadataCenter runtime_control.providerProtocol conflict: existing=openai-responses selected=anthropic-messages'
      },
      requestId: 'req-provider-protocol-boundary-fail-fast',
      providerKey: 'minimax.key1.MiniMax-M3',
      providerProtocol: 'anthropic-messages',
      runtimeKey: 'runtime:minimax',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.runtime_resolve',
      logicalRequestChainKey: 'logical-provider-protocol-boundary-no-exclusion',
      logicalChainRetryLimitStageRequestId: 'logical-provider-protocol-boundary-no-exclusion',
      routePool: ['minimax.key1.MiniMax-M3', 'orangeai.key1.glm-5.2'],
      forceExcludeCurrentProviderOnRetry: true,
      excludedProviderKeys,
      recordAttempt: () => undefined,
      logStage: () => undefined,
      logNonBlockingError: () => undefined
    });

    expect(plan.reportPlan.stageHint).toBe('provider.runtime_resolve');
    expect(plan.retryExecutionPlan.shouldRetry).toBe(false);
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(false);
    expect(plan.retryExecutionPlan.retrySwitchPlan).toBeUndefined();
    expect(excludedProviderKeys.has('minimax.key1.MiniMax-M3')).toBe(false);
  }, 10_000);

  test('provider failure plan records and blocks through global error action queue', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    const events: unknown[] = [];
    const logs: Array<{ stage: string; details?: Record<string, unknown> }> = [];
    const unregister = registerErrorActionQueueHook((event) => events.push(event));
    let resolved = false;

    const promise = resolveRequestExecutorProviderFailurePlan({
      error: Object.assign(new Error('upstream 503'), {
        code: 'HTTP_503',
        upstreamCode: 'HTTP_503',
        statusCode: 503
      }),
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        upstreamCode: 'HTTP_503',
        reason: 'upstream 503'
      },
      requestId: 'req-provider-error-backoff',
      providerKey: 'p1.gpt-test',
      providerId: 'p1',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      routeName: 'search',
      runtimeKey: 'runtime:p1',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-provider-error-backoff',
      logicalChainRetryLimitStageRequestId: 'logical-provider-error-backoff',
      routePool: ['p1.gpt-test', 'p2.gpt-test'],
      excludedProviderKeys: new Set<string>(),
      recordAttempt: () => undefined,
      logStage: (stage, _requestId, details) => {
        logs.push({ stage, details });
      },
      metadata: { entryPort: 5555 },
      logNonBlockingError: () => undefined
    }).then((plan) => {
      resolved = true;
      return plan;
    });

    await jest.advanceTimersByTimeAsync(2999);
    expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const plan = await promise;
    unregister();

    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ type: 'record', category: 'global_error', delayMs: 3000 }),
      expect.objectContaining({ type: 'wait_start', category: 'global_error', delayMs: 3000 }),
      expect.objectContaining({ type: 'wait_end', category: 'global_error', delayMs: 3000 })
    ]);
    expect(logs.some((entry) => entry.stage === 'provider.error_action_backoff_wait')).toBe(true);
    expect(logs.some((entry) => entry.stage === 'provider.error_action_backoff_wait.completed')).toBe(true);
  });

  test('local CLIENT_TOOL_ARGS_INVALID conversion failures remain recoverable only when they affect health', async () => {
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
      requestId: 'req-provider-failure-force-exclude',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      runtimeKey: 'runtime:mini27',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-provider-failure-force-exclude',
      logicalChainRetryLimitStageRequestId: 'logical-provider-failure-force-exclude',
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

  test('excludes current provider when route pool is unknown/empty and last provider is unproven', async () => {
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

    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(true);
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retryExecutionPlan.policyExhausted).toBe(false);
    expect(plan.retryExecutionPlan.mayProject).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual(['crs.crsa.gpt-5.4']);
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
      requestId: 'req-provider-failure-reroute',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      runtimeKey: 'runtime:mini27',
      dependencies: {} as any,
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      logicalRequestChainKey: 'logical-provider-failure-reroute',
      logicalChainRetryLimitStageRequestId: 'logical-provider-failure-reroute',
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

  test('single observed provider pool excludes current provider when last provider is unproven', async () => {
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
    expect(plan.retryExecutionPlan.shouldRetry).toBe(true);
    expect(plan.retryExecutionPlan.excludedCurrentProvider).toBe(true);
    expect(plan.retryExecutionPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retryExecutionPlan.policyExhausted).toBe(false);
    expect(plan.retryExecutionPlan.mayProject).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual(['asxs.gpt-5.4']);
  });
});
