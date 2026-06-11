import { jest } from '@jest/globals';
import { createRequestLocalTransientRetryTracker } from '../../../../../src/server/runtime/http-server/executor/request-executor-transient-retry-tracker.js';
import { resetRequestExecutorRetryStateForTests } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-state.js';

jest.unstable_mockModule('../../../../../src/server/runtime/http-server/executor/request-executor-native-retry-policy.js', () => ({
  resolveRequestExecutorNativeRetryPolicy: jest.fn((input: {
    classification?: string;
    isStreamingRequest?: boolean;
    hostContractFailure?: boolean;
    forceExcludeCurrentProviderOnRetry?: boolean;
    promptTooLong?: boolean;
    existingExclusion?: boolean;
  }) => {
    if (input.hostContractFailure) {
      return { excludeCurrentProvider: false, reason: 'host_contract_failure' };
    }
    if (input.forceExcludeCurrentProviderOnRetry || input.existingExclusion) {
      return { excludeCurrentProvider: true, reason: 'existing_exclusion' };
    }
    if (input.isStreamingRequest && input.classification === 'recoverable' && !input.promptTooLong) {
      return { excludeCurrentProvider: true, reason: 'streaming_recoverable_pre_response' };
    }
    return { excludeCurrentProvider: false, reason: 'preserve_existing_policy' };
  })
}));

const { resolveProviderRetryExecutionPlan } = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-retry-execution-plan.js'
);

describe('resolveProviderRetryExecutionPlan priority retry exclusions', () => {
  beforeEach(() => {
    resetRequestExecutorRetryStateForTests();
  });

  afterEach(() => {
    resetRequestExecutorRetryStateForTests();
  });

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
    expect(plan.retryBackoffMs).toBe(0);
    expect(plan.recoverableBackoffMs).toBe(0);
    expect(Array.from(excludedProviderKeys)).toContain('minimax.key1.MiniMax-M3');
  });

  it('reroutes recoverable HTTP 502 immediately when an alternative provider exists', async () => {
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
    expect(plan.requestLocalTransient).toBe(false);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(plan.retryBackoffMs).toBe(0);
    expect(plan.recoverableBackoffMs).toBe(0);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });

  it('does not retry the same provider for streaming recoverable pre-response failures', async () => {
    const excludedProviderKeys = new Set<string>();
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 525: upstream SSL handshake failed'), {
      statusCode: 525,
      code: 'HTTP_525',
      upstreamCode: 'HTTP_525'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 525,
        errorCode: 'HTTP_525',
        upstreamCode: 'HTTP_525',
        reason: 'HTTP 525: upstream SSL handshake failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'asxs.crsa.gpt-5.5',
      runtimeKey: 'asxs.crsa',
      logicalRequestChainKey: 'req-stream-no-same-provider',
      logicalChainRetryLimitStageRequestId: 'req-stream-no-same-provider',
      routePool: ['asxs.crsa.gpt-5.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker,
      isStreamingRequest: true
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.requestLocalTransient).toBe(false);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).not.toContain('same_provider');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['asxs.crsa.gpt-5.5']);
  });

  it('keeps the existing single same-provider retry for non-stream recoverable pre-response failures', async () => {
    const excludedProviderKeys = new Set<string>();
    const transientRetryTracker = createRequestLocalTransientRetryTracker();
    const error = Object.assign(new Error('HTTP 525: upstream SSL handshake failed'), {
      statusCode: 525,
      code: 'HTTP_525',
      upstreamCode: 'HTTP_525'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 525,
        errorCode: 'HTTP_525',
        upstreamCode: 'HTTP_525',
        reason: 'HTTP 525: upstream SSL handshake failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'asxs.crsa.gpt-5.5',
      runtimeKey: 'asxs.crsa',
      logicalRequestChainKey: 'req-json-keeps-same-provider',
      logicalChainRetryLimitStageRequestId: 'req-json-keeps-same-provider',
      routePool: ['asxs.crsa.gpt-5.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      transientRetryTracker,
      isStreamingRequest: false
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.requestLocalTransient).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('retry_same_provider_once');
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual([]);
  });

  it('keeps excluding current provider for repeated recoverable HTTP 502 when alternatives exist', async () => {
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

    expect(firstPlan.shouldRetry).toBe(true);
    expect(firstPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(firstPlan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);

    const repeatPlan = await resolveProviderRetryExecutionPlan({
      ...commonArgs,
      attempt: 2
    });

    expect(repeatPlan.shouldRetry).toBe(true);
    expect(repeatPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(repeatPlan.retrySwitchPlan?.runtimeScopeExcluded).toEqual([]);
    expect(repeatPlan.excludedCurrentProvider).toBe(true);
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

  it('keeps other excluded providers and adds current HTTP 503 provider for reroute', async () => {
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
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).toBe('provider_backoff_then_reroute');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['cc.key1.gpt-5.5', 'sdfv.key1.gpt-5.5']);
  });

  it('excludes current HTTP 503 provider immediately when alternatives exist', async () => {
    const excludedProviderKeys = new Set<string>();
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
