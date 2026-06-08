import { jest } from '@jest/globals';
import { resolveProviderRetryExecutionPlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-execution-plan.js';
import { createRequestLocalTransientRetryTracker } from '../../../../../src/server/runtime/http-server/executor/request-executor-transient-retry-tracker.js';

describe('resolveProviderRetryExecutionPlan priority retry exclusions', () => {
  it('never retries the same provider for recoverable 429 when retrying', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('HTTP 429'), {
      statusCode: 429,
      code: 'HTTP_429',
      upstreamCode: 'HTTP_429'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        reason: 'HTTP 429'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'minimax.key1.MiniMax-M3',
      runtimeKey: 'minimax.key1',
      logicalRequestChainKey: 'req-no-same-provider-429',
      logicalChainRetryLimitStageRequestId: 'req-no-same-provider-429',
      routePool: ['minimax.key1.MiniMax-M3', 'opencode-zen-free.key1.minimax-m3-free'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).not.toContain('same_provider');
    expect(plan.retrySwitchPlan?.runtimeScopeExcluded).toEqual([]);
    expect(plan.retrySwitchPlan?.runtimeScopeExcludedCount).toBe(0);
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toContain('minimax.key1.MiniMax-M3');
  });

  it('retries recoverable 502 on the same provider once without excluding it', async () => {
    const excludedProviderKeys = new Set<string>();
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 502: Upstream service temporarily unavailable'), {
      statusCode: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        upstreamCode: 'HTTP_502',
        reason: 'HTTP 502: Upstream service temporarily unavailable'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'sdfv.key1.gpt-5.5',
      runtimeKey: 'sdfv.key1',
      logicalRequestChainKey: 'req-priority-immediate',
      logicalChainRetryLimitStageRequestId: 'req-priority-immediate',
      routePool: ['sdfv.key1.gpt-5.5', 'tt.key1.gpt-5.5', 'cc.key1.gpt-5.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('retry_same_provider_once');
    expect(plan.retrySwitchPlan?.decisionLabel).toBe('recoverable_backoff_same_provider');
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual([]);
  });

  it('switches provider after the same recoverable error repeats on the same provider', async () => {
    const excludedProviderKeys = new Set<string>();
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 502: Upstream service temporarily unavailable'), {
      statusCode: 502,
      code: 'HTTP_502',
      upstreamCode: 'HTTP_502'
    });
    const commonArgs = {
      error,
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        upstreamCode: 'HTTP_502',
        reason: 'HTTP 502: Upstream service temporarily unavailable'
      },
      maxAttempts: 6,
      stage: 'provider.send' as const,
      providerKey: 'sdfv.key1.gpt-5.5',
      runtimeKey: 'sdfv.key1',
      logicalRequestChainKey: 'req-priority-repeat',
      logicalChainRetryLimitStageRequestId: 'req-priority-repeat',
      routePool: ['sdfv.key1.gpt-5.5', 'tt.key1.gpt-5.5', 'cc.key1.gpt-5.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker
    };

    const firstPlan = await resolveProviderRetryExecutionPlan({
      ...commonArgs,
      attempt: 1
    });
    const secondPlan = await resolveProviderRetryExecutionPlan({
      ...commonArgs,
      attempt: 2
    });

    expect(firstPlan.retrySwitchPlan?.switchAction).toBe('retry_same_provider_once');
    expect(secondPlan.shouldRetry).toBe(true);
    expect(secondPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(secondPlan.retrySwitchPlan?.runtimeScopeExcluded).toEqual([]);
    expect(secondPlan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });

  it('reroutes unrecoverable provider failures when route pool has an alternative', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('HTTP 403: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}'), {
      statusCode: 403,
      code: 'HTTP_403',
      upstreamCode: 'INSUFFICIENT_BALANCE'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 403,
        errorCode: 'HTTP_403',
        upstreamCode: 'INSUFFICIENT_BALANCE',
        reason: 'HTTP 403: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'dibittai.crsa.gpt-5.5',
      runtimeKey: 'dibittai.crsa',
      logicalRequestChainKey: 'req-direct-403-cycle',
      logicalChainRetryLimitStageRequestId: 'req-direct-403-cycle',
      routePool: ['dibittai.crsa.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).not.toContain('same_provider');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['dibittai.crsa.gpt-5.5']);
  });

  it('keeps other excluded providers but does not add current provider on first recoverable retry', async () => {
    const excludedProviderKeys = new Set<string>(['cc.key1.gpt-5.5']);
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 503'), {
      statusCode: 503,
      code: 'HTTP_503',
      upstreamCode: 'HTTP_503'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        upstreamCode: 'HTTP_503',
        reason: 'HTTP 503'
      },
      attempt: 3,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'sdfv.key1.gpt-5.5',
      runtimeKey: 'sdfv.key1',
      logicalRequestChainKey: 'req-priority',
      logicalChainRetryLimitStageRequestId: 'req-priority',
      routePool: ['sdfv.key1.gpt-5.5', 'cc.key1.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('retry_same_provider_once');
    expect(plan.retrySwitchPlan?.decisionLabel).toBe('recoverable_backoff_same_provider');
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual(['cc.key1.gpt-5.5']);
  });

  it('excludes current provider only after repeated recoverable error when alternatives exist', async () => {
    const excludedProviderKeys = new Set<string>();
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 503'), {
      statusCode: 503,
      code: 'HTTP_503',
      upstreamCode: 'HTTP_503'
    });

    await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        upstreamCode: 'HTTP_503',
        reason: 'HTTP 503'
      },
      attempt: 3,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'sdfv.key1.gpt-5.5',
      runtimeKey: 'sdfv.key1',
      logicalRequestChainKey: 'req-priority-threshold',
      logicalChainRetryLimitStageRequestId: 'req-priority-threshold',
      routePool: ['sdfv.key1.gpt-5.5', 'cc.key1.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker
    });
    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 503,
        errorCode: 'HTTP_503',
        upstreamCode: 'HTTP_503',
        reason: 'HTTP 503'
      },
      attempt: 2,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'sdfv.key1.gpt-5.5',
      runtimeKey: 'sdfv.key1',
      logicalRequestChainKey: 'req-priority-threshold',
      logicalChainRetryLimitStageRequestId: 'req-priority-threshold',
      routePool: ['sdfv.key1.gpt-5.5', 'cc.key1.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).not.toContain('same_provider');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });
});
