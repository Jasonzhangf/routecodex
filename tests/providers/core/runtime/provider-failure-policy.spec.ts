import { describe, expect, it } from '@jest/globals';
import {
  describeProviderFailureDecision,
  isProviderFailureHealthNeutral,
  resolveProviderFailureActionPlan,
  resolveProviderFailureClassification
} from '../../../../src/providers/core/runtime/provider-failure-policy.js';

describe('provider failure policy ssot', () => {
  it('classifies invalid access token as unrecoverable', () => {
    const error = Object.assign(new Error('invalid access token or token expired'), {
      code: 'invalid_api_key',
      statusCode: 401
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 401,
      errorCode: 'invalid_api_key',
      reason: 'invalid access token or token expired'
    });

    expect(classification).toBe('unrecoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'invalid_api_key',
      statusCode: 401,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 401,
      errorCode: 'invalid_api_key',
      reason: 'invalid access token or token expired',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: true,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return',
      backoff: expect.objectContaining({
        scope: 'none',
        baseMs: 0,
        maxMs: 0
      })
    }));
  });

  it('classifies context overflow as special_400', () => {
    const error = Object.assign(new Error('Request input tokens exceeds the model maximum context length'), {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      statusCode: 400
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      reason: 'Request input tokens exceeds the model maximum context length'
    });

    expect(classification).toBe('special_400');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      statusCode: 400,
      classification
    })).toBe(true);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      reason: 'Request input tokens exceeds the model maximum context length',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'special_400',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return',
      backoff: expect.objectContaining({
        scope: 'none'
      })
    }));
  });

  it('classifies sqlite busy 500 as recoverable and health-neutral', () => {
    const error = Object.assign(new Error('database is locked (5) (SQLITE_BUSY)'), {
      code: 'new_api_error',
      upstreamCode: 'new_api_error',
      statusCode: 500
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 500,
      errorCode: 'new_api_error',
      upstreamCode: 'new_api_error',
      reason: 'database is locked (5) (SQLITE_BUSY)'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'new_api_error',
      upstreamCode: 'new_api_error',
      statusCode: 500,
      classification
    })).toBe(true);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 500,
      errorCode: 'new_api_error',
      upstreamCode: 'new_api_error',
      reason: 'database is locked (5) (SQLITE_BUSY)',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: false,
      blockingRecoverable: true,
      shouldRetry: true,
      action: 'retry_same_provider',
      decisionLabel: 'recoverable_backoff_same_provider',
      backoff: expect.objectContaining({
        scope: 'recoverable'
      })
    }));
  });

  it('classifies short-lived 429 as recoverable and health-neutral', () => {
    const error = Object.assign(new Error('HTTP 429: transient limit'), {
      statusCode: 429
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.http',
      statusCode: 429,
      reason: 'HTTP 429: transient limit'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.http',
      statusCode: 429,
      classification
    })).toBe(true);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.http',
      statusCode: 429,
      reason: 'HTTP 429: transient limit',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: false,
      blockingRecoverable: true,
      shouldRetry: true,
      action: 'retry_same_provider',
      decisionLabel: 'recoverable_backoff_same_provider',
      backoff: expect.objectContaining({
        scope: 'recoverable'
      })
    }));
  });

  it('does not force direct return when blocking recoverable 429 reaches maxAttempts', () => {
    const error = Object.assign(new Error('HTTP 429: transient limit'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 429,
      errorCode: 'HTTP_429',
      reason: 'HTTP 429: transient limit',
      attempt: 6,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: false,
      blockingRecoverable: true,
      shouldRetry: true,
      action: 'retry_same_provider',
      decisionLabel: 'recoverable_backoff_same_provider',
      backoff: expect.objectContaining({
        scope: 'recoverable'
      })
    }));
  });

  it('treats transport fetch failed as recoverable same-provider blocking backoff', () => {
    const error = Object.assign(new Error('fetch failed'), {
      code: 'HTTP_502',
      statusCode: 502
    });
    const plan = resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'HTTP_502',
      reason: 'fetch failed',
      attempt: 1,
      maxAttempts: 6
    });

    expect(plan).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: false,
      blockingRecoverable: true,
      shouldRetry: true,
      action: 'retry_same_provider',
      decisionLabel: 'recoverable_backoff_same_provider',
      backoff: expect.objectContaining({
        scope: 'recoverable'
      })
    }));
  });

  it('supports provider-scoped reroute decision labels from the shared policy', () => {
    expect(describeProviderFailureDecision({
      action: 'reroute_explicit_alternative',
      backoffScope: 'provider'
    })).toBe('provider_backoff_then_reroute');
  });

  it('keeps host/followup stages outside provider policy classification', () => {
    expect(resolveProviderFailureClassification({
      error: new Error('followup failed'),
      stage: 'provider.followup',
      statusCode: 502,
      reason: 'followup failed'
    })).toBeUndefined();

    expect(resolveProviderFailureClassification({
      error: new Error('stopless contract violated'),
      stage: 'host.stopless_contract',
      statusCode: 502,
      reason: 'stopless contract violated'
    })).toBeUndefined();
  });
});
