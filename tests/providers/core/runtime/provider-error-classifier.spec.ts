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

describe('Provider error classifier - internal conversion errors', () => {
  const baseContext = {
    requestId: 'req_test',
    providerKey: 'tab.key1.gpt-5.2-codex',
    providerType: 'openai',
    providerFamily: 'openai',
    providerProtocol: 'openai-responses',
    model: 'gpt-5.2-codex'
  } as any;

  it('treats SSE_TO_JSON_ERROR as recoverable and does not affect health', () => {
    const error = Object.assign(new Error('SSE_TO_JSON_ERROR: terminated'), { code: 'SSE_TO_JSON_ERROR' });
    const classification = classifyProviderError({
      error,
      context: baseContext,
      detectDailyLimit: () => false,
      registerRateLimitFailure: () => false,
      forceRateLimitFailure: () => {},
      authMode: 'apikey'
    });

    expect(classification.recoverable).toBe(true);
    expect(classification.affectsHealth).toBe(false);
    expect(classification.isRateLimit).toBe(false);
  });

  it('treats iflow upstream 434 blocked-account as non-recoverable and health-affecting', () => {
    const error = Object.assign(
      new Error('HTTP 400: iFlow business error (434): Access to the current AK has been blocked due to unauthorized requests'),
      {
        response: {
          status: 400,
          data: {
            upstream: {
              status: '434',
              msg: 'Access to the current AK has been blocked due to unauthorized requests'
            }
          }
        }
      }
    );
    const classification = classifyProviderError({
      error,
      context: baseContext,
      detectDailyLimit: () => false,
      registerRateLimitFailure: () => false,
      forceRateLimitFailure: () => {},
      authMode: 'oauth'
    });

    expect(classification.statusCode).toBe(434);
    expect(classification.recoverable).toBe(false);
    expect(classification.affectsHealth).toBe(true);
    expect(classification.isRateLimit).toBe(false);
  });
});
