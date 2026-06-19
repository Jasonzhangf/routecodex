import { describe, expect, it } from '@jest/globals';

import { __requestExecutorTestables } from '../../../../src/server/runtime/http-server/request-executor';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

describe('request-executor excluded provider reselection plan', () => {
  it('keeps excluded provider excluded when alternative candidates still exist', () => {
    expect(__requestExecutorTestables.resolveExcludedProviderReselectionPlan({
      providerKey: 'qwenchat.1.qwen3.6-plus',
      routePool: ['qwenchat.1.qwen3.6-plus', 'qwenchat.2.qwen3.6-plus'],
      excludedProviderKeys: new Set(['qwenchat.1.qwen3.6-plus']),
      lastError: Object.assign(new Error('Failed to create qwenchat session: HTTP 404'), {
        statusCode: 404,
        code: 'QWENCHAT_CREATE_SESSION_FAILED',
        retryable: true
      })
    })).toEqual({
      hasAlternativeCandidate: true,
      keepExcludedForNextAttempt: true
    });
  });

  it('releases excluded provider when it is the only remaining candidate', () => {
    expect(__requestExecutorTestables.resolveExcludedProviderReselectionPlan({
      providerKey: 'glm.key1.glm-4.7',
      routePool: ['glm.key1.glm-4.7'],
      excludedProviderKeys: new Set(['glm.key1.glm-4.7']),
      lastError: Object.assign(new Error('HTTP 429: quota exhausted'), {
        statusCode: 429,
        code: 'HTTP_429',
        retryable: true
      })
    })).toEqual({
      hasAlternativeCandidate: false,
      keepExcludedForNextAttempt: false
    });
  });

  it('keeps excluded provider excluded when current routingDecision pool was narrowed but initial route pool still has alternatives', () => {
    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-provider-weekly-reroute',
      providerRequestId: 'req-provider-weekly-reroute',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'thinking',
          pool: ['openai.key1.gpt-5.4-medium'],
          routePool: [
            'openai.key1.gpt-5.4-medium',
            'openai.key2.gpt-5.4-medium',
            'openai.key3.gpt-5.4-medium',
          ],
        },
        providerPayload: { body: { model: 'gpt-5.4-medium' } },
        target: {
          providerKey: 'openai.key1.gpt-5.4-medium',
          runtimeKey: 'openai.key1',
          compatibilityProfile: 'chat:openai',
        },
        metadata: {},
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-provider-weekly-reroute',
      clientAbortSignal: undefined,
      initialRoutePool: [
        'openai.key1.gpt-5.4-medium',
        'openai.key2.gpt-5.4-medium',
        'openai.key3.gpt-5.4-medium',
      ],
      excludedProviderKeys: new Set(['openai.key1.gpt-5.4-medium']),
      lastError: Object.assign(
        new Error('Your weekly usage quota has been exhausted.'),
        {
          status: 429,
          code: 'HTTP_429',
          upstreamCode: 'HTTP_429',
          retryable: false,
          quotaScope: 'weekly',
        }
      ),
      blockingRecoverableRouteHoldState: null,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    });

    expect(resolved).toEqual({
      kind: 'retry_next_attempt',
      initialRoutePool: [
        'openai.key1.gpt-5.4-medium',
        'openai.key2.gpt-5.4-medium',
        'openai.key3.gpt-5.4-medium',
      ]
    });
  });

  it('writes provider observation into MetadataCenter instead of reviving flat target metadata', () => {
    const metadataForAttempt: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadataForAttempt);

    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-provider-observation-center-1',
      providerRequestId: 'req-provider-observation-center-1',
      attempt: 1,
      metadataForAttempt,
      pipelineResult: {
        routingDecision: {
          routeName: 'search',
          routePool: ['minimax.key1.MiniMax-M2.7']
        },
        providerPayload: { model: 'MiniMax-M2.7' },
        target: {
          providerKey: 'minimax.key1.MiniMax-M2.7',
          runtimeKey: 'minimax.key1',
          compatibilityProfile: 'openai-responses',
          modelId: 'MiniMax-M2.7'
        },
        metadata: {}
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-provider-observation-center-1',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: new Set<string>(),
      lastError: null,
      blockingRecoverableRouteHoldState: null,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    });

    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') {
      return;
    }
    expect(resolved.mergedMetadata.target).toBeUndefined();
    expect(resolved.mergedMetadata.compatibilityProfile).toBeUndefined();
    expect(center.readProviderObservation()).toMatchObject({
      providerKey: 'minimax.key1.MiniMax-M2.7',
      modelId: 'MiniMax-M2.7',
      assignedModelId: 'MiniMax-M2.7',
      compatibilityProfile: 'openai-responses',
      target: {
        providerKey: 'minimax.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7',
        compatibilityProfile: 'openai-responses'
      }
    });
  });

  it('keeps excluded provider excluded when later-pool/default alternatives still exist', () => {
    expect(__requestExecutorTestables.resolveExcludedProviderReselectionPlan({
      providerKey: 'minimax.key1.MiniMax-M3',
      routePool: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4', 'default.key1.gpt-5.4'],
      excludedProviderKeys: new Set(['minimax.key1.MiniMax-M3']),
      lastError: Object.assign(new Error('HTTP 429: quota exhausted'), {
        statusCode: 429,
        code: 'HTTP_429',
        retryable: true
      })
    })).toEqual({
      hasAlternativeCandidate: true,
      keepExcludedForNextAttempt: true
    });
  });


  it('reads full routePool chain when routingDecision.pool is only the narrowed current pool', () => {
    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-routepool-contract',
      providerRequestId: 'req-routepool-contract',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'search',
          pool: ['minimax.key1.MiniMax-M3'],
          routePool: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4', 'default.key1.gpt-5.4']
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
      clientRequestId: 'req-routepool-contract',
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
    });

    expect(resolved).toEqual({
      kind: 'retry_next_attempt',
      initialRoutePool: [
        'minimax.key1.MiniMax-M3',
        'asxs.crsa.gpt-5.4',
        'default.key1.gpt-5.4'
      ]
    });
  });

  it('treats routingDecision.pool as an explicit routePool carrier when excluded provider is reselected', () => {
    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-no-explicit-routepool',
      providerRequestId: 'req-no-explicit-routepool',
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
      clientRequestId: 'req-no-explicit-routepool',
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
    });

    expect(resolved).toEqual({
      kind: 'resolved',
      mergedMetadata: {
        clientRequestId: 'req-no-explicit-routepool'
      },
      mergedClientHeaders: undefined,
      routePoolForAttempt: ['minimax.key1.MiniMax-M3'],
      providerPayload: { body: { model: 'gpt-test' } },
      target: {
        providerKey: 'minimax.key1.MiniMax-M3',
        runtimeKey: 'minimax.key1',
        compatibilityProfile: 'openai:responses'
      },
      initialRoutePool: ['minimax.key1.MiniMax-M3']
    });
  });

  it('keeps fallback routePool chain available when current pool is exhausted', () => {
    const resolved = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-fallback-chain',
      providerRequestId: 'req-fallback-chain',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'search',
          pool: ['minimax.key1.MiniMax-M3'],
          routePool: ['minimax.key1.MiniMax-M3', 'asxs.crsa.gpt-5.4', 'default.key1.gpt-5.4']
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
      clientRequestId: 'req-fallback-chain',
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
    });

    expect(resolved).toEqual({
      kind: 'retry_next_attempt',
      initialRoutePool: [
        'minimax.key1.MiniMax-M3',
        'asxs.crsa.gpt-5.4',
        'default.key1.gpt-5.4'
      ]
    });
  });
});
