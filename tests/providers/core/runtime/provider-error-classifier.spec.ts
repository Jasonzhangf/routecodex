import { describe, expect, it } from '@jest/globals';
import { classifyProviderError } from '../../../../src/providers/core/runtime/provider-error-classifier.js';
import { RateLimitCooldownError } from '../../../../src/providers/core/runtime/rate-limit-manager.js';

describe('Provider error classifier - 429 handling', () => {
  const baseContext = {
    requestId: 'req_test',
    providerKey: 'antigravity.alias1.gemini-3-pro-high',
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerProtocol: 'gemini-chat',
    model: 'gemini-3-pro-high'
  } as any;

  it('treats short-term 429 as recoverable even when registerRateLimitFailure escalates', () => {
    let registerCalled = false;
    const classification = classifyProviderError({
      error: Object.assign(new Error('HTTP 429: transient limit'), {
        response: { status: 429, data: { error: { status: 429, message: 'transient limit' } } }
      }),
      context: baseContext,
      detectDailyLimit: () => false,
      registerRateLimitFailure: () => {
        registerCalled = true;
        return true;
      },
      forceRateLimitFailure: () => {
        throw new Error('forceRateLimitFailure should not be called for short-term 429');
      },
      authMode: 'apikey'
    });

    expect(registerCalled).toBe(true);
    expect(classification.isRateLimit).toBe(true);
    expect(classification.isDailyLimitRateLimit).toBe(false);
    expect(classification.recoverable).toBe(true);
    expect(classification.forceFatalRateLimit).toBe(false);
    expect(classification.affectsHealth).toBe(true);
  });

  it('marks daily-limit 429 as non-recoverable and fatal', () => {
    let forceCalled = false;
    const classification = classifyProviderError({
      error: Object.assign(new Error('HTTP 429: quota has been exhausted'), {
        response: {
          status: 429,
          data: { error: { status: 429, message: 'quota has been exhausted' } }
        }
      }),
      context: baseContext,
      detectDailyLimit: () => true,
      registerRateLimitFailure: () => false,
      forceRateLimitFailure: () => {
        forceCalled = true;
      },
      authMode: 'apikey'
    });

    expect(forceCalled).toBe(true);
    expect(classification.isRateLimit).toBe(true);
    expect(classification.isDailyLimitRateLimit).toBe(true);
    expect(classification.recoverable).toBe(false);
    expect(classification.forceFatalRateLimit).toBe(true);
    expect(classification.affectsHealth).toBe(true);
  });

  it('does not escalate synthetic RateLimitCooldownError via register/force hooks', () => {
    let registerCalled = false;
    let forceCalled = false;
    const error = new RateLimitCooldownError('provider cooling down after 429', 1_000);

    const classification = classifyProviderError({
      error,
      context: baseContext,
      detectDailyLimit: () => false,
      registerRateLimitFailure: () => {
        registerCalled = true;
        return true;
      },
      forceRateLimitFailure: () => {
        forceCalled = true;
      },
      authMode: 'apikey'
    });

    expect(registerCalled).toBe(false);
    expect(forceCalled).toBe(false);
    expect(classification.isRateLimit).toBe(true);
    expect(classification.isDailyLimitRateLimit).toBe(false);
    expect(classification.recoverable).toBe(true);
    expect(classification.forceFatalRateLimit).toBe(false);
    expect(classification.affectsHealth).toBe(false);
  });
});
