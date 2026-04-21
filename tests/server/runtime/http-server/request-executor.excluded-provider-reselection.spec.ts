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
});
