import { jest } from '@jest/globals';
import { resetRequestExecutorRetryStateForTests } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-state.js';

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
    expect(Array.from(excludedProviderKeys)).toContain('minimax.key1.MiniMax-M3');
  });

  it('preserves base exclusion for non-streaming recoverable 429 with alternative candidates', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('HTTP 429: overload'), {
      statusCode: 429,
      code: 'HTTP_429_2056',
      upstreamCode: 'HTTP_429_2056'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429_2056',
        upstreamCode: 'HTTP_429_2056',
        reason: 'HTTP 429: overload'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      runtimeKey: 'mini27.key1',
      logicalRequestChainKey: 'req-preserve-base-exclusion-429',
      logicalChainRetryLimitStageRequestId: 'req-preserve-base-exclusion-429',
      routePool: ['mini27.key1.MiniMax-M2.7', 'minimax.key1.MiniMax-M3'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      isStreamingRequest: false
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).toBe('exclude_and_reroute');
    expect(Array.from(excludedProviderKeys)).toEqual(['mini27.key1.MiniMax-M2.7']);
  });

  it('reroutes recoverable HTTP 502 immediately when an alternative provider exists', async () => {
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
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });

  it('reroutes provider protocol mismatch instead of blocking provider switching', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(
      new Error('Provider protocol mismatch: handle=openai-responses target=anthropic-messages'),
      {
        code: 'ERR_PROVIDER_PROTOCOL_MISMATCH'
      }
    );

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        errorCode: 'ERR_PROVIDER_PROTOCOL_MISMATCH',
        reason: 'Provider protocol mismatch: handle=openai-responses target=anthropic-messages'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.runtime_resolve',
      providerKey: 'minimax.key1.MiniMax-M3',
      runtimeKey: 'runtime:minimax',
      logicalRequestChainKey: 'req-protocol-mismatch-reroute',
      logicalChainRetryLimitStageRequestId: 'req-protocol-mismatch-reroute',
      routePool: ['minimax.key1.MiniMax-M3', 'orangeai.key1.glm-5.2'],
      forceExcludeCurrentProviderOnRetry: true,
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(Array.from(excludedProviderKeys)).toEqual(['minimax.key1.MiniMax-M3']);
  });

  it('does not reroute provider-owned continuation failures across providers', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('HTTP 502: SSE_TO_JSON_ERROR'), {
      statusCode: 502,
      code: 'SSE_TO_JSON_ERROR',
      upstreamCode: 'upstream_error'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        statusCode: 502,
        errorCode: 'SSE_TO_JSON_ERROR',
        upstreamCode: 'upstream_error',
        reason: 'HTTP 502: SSE_TO_JSON_ERROR'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: '1token.key1.gpt-5.5',
      runtimeKey: '1token.key1',
      logicalRequestChainKey: 'req-provider-owned-continuation',
      logicalChainRetryLimitStageRequestId: 'req-provider-owned-continuation',
      routePool: ['1token.key1.gpt-5.5', 'minimax.key1.MiniMax-M3'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      isStreamingRequest: true,
      providerOwnedContinuation: true
    });

    expect(plan.shouldRetry).toBe(false);
    expect(plan.retrySwitchPlan).toBeUndefined();
    expect(Array.from(excludedProviderKeys)).toEqual(['1token.key1.gpt-5.5']);
  });

  it('keeps reroute enabled for relay continuation recoverable failures when an alternative provider exists', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('HTTP 502: fetch failed'), {
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
        reason: 'HTTP 502: fetch failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'relay.key1.gpt-5.5',
      runtimeKey: 'relay.key1',
      logicalRequestChainKey: 'req-relay-continuation-reroute',
      logicalChainRetryLimitStageRequestId: 'req-relay-continuation-reroute',
      routePool: ['relay.key1.gpt-5.5', 'relay.key2.gpt-5.5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      isStreamingRequest: true,
      providerOwnedContinuation: false
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan).toEqual(expect.objectContaining({
      switchAction: 'exclude_and_reroute',
      decisionLabel: 'exclude_and_reroute'
    }));
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['relay.key1.gpt-5.5']);
  });

  it('allows bounded same-provider retry for streaming recoverable failure when this is the last provider', async () => {
    const excludedProviderKeys = new Set<string>();
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
      isStreamingRequest: true
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan).toBeUndefined();
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual([]);
  });

  it('allows bounded same-provider retry when non-stream recoverable failure is already the last provider', async () => {
    const excludedProviderKeys = new Set<string>();
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
      isStreamingRequest: false
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan).toBeUndefined();
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual([]);
  });

  it('allows bounded same-provider retry for provider send SSE/network wrappers when this is the last provider', async () => {
    const excludedProviderKeys = new Set<string>();
    const error = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET'
    });

    const plan = await resolveProviderRetryExecutionPlan({
      error,
      retryError: {
        errorCode: 'ECONNRESET',
        reason: 'fetch failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.sse_decode',
      providerKey: 'storm.a.glm-5',
      runtimeKey: 'storm.a',
      logicalRequestChainKey: 'req-last-provider-sse-wrapper',
      logicalChainRetryLimitStageRequestId: 'req-last-provider-sse-wrapper',
      routePool: ['storm.a.glm-5'],
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn(),
      isStreamingRequest: false
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan).toBeUndefined();
    expect(plan.excludedCurrentProvider).toBe(false);
    expect(Array.from(excludedProviderKeys)).toEqual([]);
  });

  it('requests reroute when current pool is exhausted but VR default pool is still available', async () => {
    const excludedProviderKeys = new Set<string>(['primary.key1.gpt-5.5']);
    const error = Object.assign(new Error('HTTP 502: upstream failed'), {
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
        reason: 'HTTP 502: upstream failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.send',
      providerKey: 'primary.key1.gpt-5.5',
      runtimeKey: 'primary.key1',
      logicalRequestChainKey: 'req-default-pool-reroute',
      logicalChainRetryLimitStageRequestId: 'req-default-pool-reroute',
      routePool: ['primary.key1.gpt-5.5'],
      defaultTierAvailable: true,
      excludedProviderKeys,
      recordAttempt: jest.fn(),
      logStage: jest.fn(),
      logNonBlockingError: jest.fn()
    });

    expect(plan.routePoolRemainingAfterExclusion).toEqual([]);
    expect(plan.defaultPoolAvailable).toBe(true);
    expect(plan.policyExhausted).toBe(false);
    expect(plan.mayProject).toBe(false);
    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.excludedCurrentProvider).toBe(true);
  });

  it('excludes current provider for recoverable HTTP 502 as soon as alternatives exist', async () => {
    const excludedProviderKeys = new Set<string>();
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
      logNonBlockingError: jest.fn()
    };

    const firstPlan = await resolveProviderRetryExecutionPlan({
      ...commonArgs,
      attempt: 1
    });

    expect(firstPlan.shouldRetry).toBe(true);
    expect(firstPlan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(firstPlan.retrySwitchPlan?.runtimeScopeExcluded).toEqual([]);
    expect(firstPlan.excludedCurrentProvider).toBe(true);
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
    expect(plan.retrySwitchPlan?.decisionLabel).toBe('exclude_and_reroute');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['cc.key1.gpt-5.5', 'sdfv.key1.gpt-5.5']);
  });

  it('excludes current HTTP 503 provider immediately when alternatives exist', async () => {
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
      logNonBlockingError: jest.fn()
    });

    expect(plan.shouldRetry).toBe(true);
    expect(plan.retrySwitchPlan?.switchAction).toBe('exclude_and_reroute');
    expect(plan.retrySwitchPlan?.decisionLabel).not.toContain('same_provider');
    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excludedProviderKeys)).toEqual(['sdfv.key1.gpt-5.5']);
  });
});
