import { describe, expect, it } from '@jest/globals';

import { __requestExecutorTestables } from '../../../../src/server/runtime/http-server/request-executor';

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
});
