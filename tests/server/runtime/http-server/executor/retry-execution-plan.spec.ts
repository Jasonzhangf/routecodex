import { jest } from '@jest/globals';
import { resolveProviderRetryExecutionPlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-execution-plan.js';

describe('resolveProviderRetryExecutionPlan priority retry exclusions', () => {
  it('excludes current provider immediately on recoverable 502 when pool alternatives exist', async () => {
    const excludedProviderKeys = new Set<string>();
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
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });

  it('does not clear other excluded providers on recoverable retry threshold', async () => {
    const excludedProviderKeys = new Set<string>(['cc.key1.gpt-5.5']);
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
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(Array.from(excludedProviderKeys)).toEqual(['cc.key1.gpt-5.5', 'sdfv.key1.gpt-5.5']);
  });

  it('excludes current provider on recoverable retry threshold when alternatives exist', async () => {
    const excludedProviderKeys = new Set<string>();
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
      logicalRequestChainKey: 'req-priority-threshold',
      logicalChainRetryLimitStageRequestId: 'req-priority-threshold',
      routePool: ['sdfv.key1.gpt-5.5', 'cc.key1.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });
});
