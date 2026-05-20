import { describe, expect, it } from '@jest/globals';
import {
  resolveProviderFailureActionPlan,
  resolveProviderFailureClassification,
  resolveProviderFailureExclusionDecision
} from '../../../../src/providers/core/runtime/provider-failure-policy.js';

describe('provider failure policy windsurf not implemented', () => {
  it('treats WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED as unrecoverable and reroute-worthy', () => {
    const error = Object.assign(
      new Error('WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED: cloud chat path unavailable'),
      {
        code: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
        upstreamCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
        statusCode: 501,
      }
    );

    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 501,
      errorCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      upstreamCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      reason: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED: cloud chat path unavailable'
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 501,
      errorCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      upstreamCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      reason: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED: cloud chat path unavailable',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      shouldRetry: false,
      action: 'direct_return',
    }));

    expect(resolveProviderFailureExclusionDecision({
      classification,
      statusCode: 501,
      errorCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      upstreamCode: 'WINDSURF_CLOUD_CHAT_NOT_IMPLEMENTED',
      promptTooLong: false,
      hasAlternativeCandidate: true,
      is429: false,
      isVerify: false,
      isReauth: false,
      isProviderTrafficSaturated: false,
      isNetworkTransport: false,
    })).toEqual({
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    });
  });
});
