import { beforeEach, describe, expect, it } from '@jest/globals';

describe('request-executor cross-pool fallback red', () => {
  beforeEach(async () => {
    const { __requestExecutorTestables } = await import('../../../../../src/server/runtime/http-server/request-executor.js');
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
  });

  it('RED: preserves the first explicit full routePool chain when later attempts only expose a narrowed current pool', async () => {
    const { __requestExecutorTestables } = await import('../../../../../src/server/runtime/http-server/request-executor.js');

    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-cross-pool-preserve-chain',
      providerRequestId: 'req-cross-pool-preserve-chain',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'default',
          pool: ['asxs.crsa.gpt-5.4'],
          routePool: ['asxs.crsa.gpt-5.4']
        },
        providerPayload: { body: { model: 'gpt-test' } },
        target: {
          providerKey: 'asxs.crsa.gpt-5.4',
          runtimeKey: 'asxs.crsa',
          compatibilityProfile: 'openai:responses'
        },
        metadata: {}
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-cross-pool-preserve-chain',
      clientAbortSignal: undefined,
      initialRoutePool: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4'],
      excludedProviderKeys: new Set(['minimax.key1.MiniMax-M3']),
      lastError: Object.assign(new Error('HTTP 429: quota exhausted'), {
        status: 429,
        code: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        retryable: true
      }),
      blockingRecoverableRouteHoldState: null,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    });

    expect(resolved).toEqual(expect.objectContaining({
      kind: 'resolved',
      initialRoutePool: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4'],
      routePoolForAttempt: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4']
    }));
  });

  it('NEG: fails fast instead of surfacing upstream error when an excluded provider is reselected', async () => {
    const { __requestExecutorTestables } = await import('../../../../../src/server/runtime/http-server/request-executor.js');

    expect(() => __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-cross-pool-no-synthesis',
      providerRequestId: 'req-cross-pool-no-synthesis',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'search',
          pool: ['minimax.key1.MiniMax-M3']
        },
        providerPayload: { body: { model: 'gpt-test' } },
        target: {
          providerKey: 'minimax.key1.MiniMax-M3',
          runtimeKey: 'minimax.key1',
          compatibilityProfile: 'openai:responses'
        },
        metadata: {}
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-cross-pool-no-synthesis',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: new Set(['minimax.key1.MiniMax-M3']),
      lastError: Object.assign(new Error('HTTP 429: quota exhausted'), {
        status: 429,
        code: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        retryable: true
      }),
      blockingRecoverableRouteHoldState: null,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    })).toThrow(/Virtual router reselected excluded provider minimax\.key1\.MiniMax-M3/);
  });
});
