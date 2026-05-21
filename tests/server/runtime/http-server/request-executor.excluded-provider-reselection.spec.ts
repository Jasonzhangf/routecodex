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
      inputRequestId: 'req-ws-weekly-reroute',
      providerRequestId: 'req-ws-weekly-reroute',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        routingDecision: {
          routeName: 'thinking',
          pool: ['windsurf.ws-pro-1.gpt-5.4-medium'],
        },
        providerPayload: { body: { model: 'gpt-5.4-medium' } },
        target: {
          providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
          runtimeKey: 'windsurf.ws-pro-1',
          compatibilityProfile: 'chat:windsurf',
        },
        metadata: {},
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-ws-weekly-reroute',
      clientAbortSignal: undefined,
      initialRoutePool: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium',
      ],
      excludedProviderKeys: new Set(['windsurf.ws-pro-1.gpt-5.4-medium']),
      lastError: Object.assign(
        new Error('Your weekly usage quota has been exhausted.'),
        {
          status: 429,
          code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
          upstreamCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
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
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium',
      ]
    });
  });
});
