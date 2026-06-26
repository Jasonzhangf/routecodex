import { describe, expect, it } from '@jest/globals';
import {
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
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies HTTP 404 as unrecoverable direct-return', () => {
    const error = Object.assign(new Error('HTTP 404: {"detail":"Not Found"}'), {
      code: 'HTTP_404',
      statusCode: 404
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 404,
      errorCode: 'HTTP_404',
      upstreamCode: 'HTTP_404',
      reason: 'HTTP 404: {"detail":"Not Found"}'
    });

    expect(classification).toBe('unrecoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'HTTP_404',
      upstreamCode: 'HTTP_404',
      statusCode: 404,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 404,
      errorCode: 'HTTP_404',
      upstreamCode: 'HTTP_404',
      reason: 'HTTP 404: {"detail":"Not Found"}',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: true,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies HTTP 429 as recoverable without rate-limit side metadata', () => {
    const rateLimitedError = Object.assign(new Error('HTTP 429: saturated'), {
      code: 'HTTP_429',
      statusCode: 429
    });

    expect(resolveProviderFailureClassification({
      error: rateLimitedError,
      stage: 'provider.send',
      statusCode: 429,
      errorCode: 'HTTP_429',
      reason: 'HTTP 429: saturated'
    })).toBe('recoverable');
  });

  it('classifies DeepSeek file upload failure as unrecoverable direct-return', () => {
    const error = Object.assign(new Error('DeepSeek file upload returned non-JSON payload'), {
      code: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      upstreamCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      statusCode: 502
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      upstreamCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      reason: 'DeepSeek file upload returned non-JSON payload'
    });

    expect(classification).toBe('unrecoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      upstreamCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      statusCode: 502,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      upstreamCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      reason: 'DeepSeek file upload returned non-JSON payload',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: true,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies context overflow as recoverable and health-affecting', () => {
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

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      statusCode: 400,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      reason: 'Request input tokens exceeds the model maximum context length',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('classifies responses runtime payload contract failures as health-neutral unrecoverable local errors', () => {
    const reason = 'provider-runtime-error: responses payload missing "input" or "instructions"';
    const error = new Error(reason);
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      reason
    });

    expect(classification).toBe('unrecoverable');
    expect(isProviderFailureHealthNeutral({
      error,
      stage: 'provider.send',
      reason,
      classification
    } as any)).toBe(true);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      reason,
      attempt: 2,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      reason,
      attempt: 2,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      shouldRetry: false
    }));
  });

  it('classifies responses reasoning.content array_above_max_length as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(
      new Error("HTTP 400: Invalid 'input[22].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead."),
      {
        statusCode: 400,
        code: 'HTTP_400',
        response: {
          data: {
            error: {
              message: "Invalid 'input[22].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.",
              type: 'invalid_request_error',
              param: 'input[22].content',
              code: 'array_above_max_length'
            }
          }
        }
      }
    );
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies thinking.signature invalid as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(
      new Error('HTTP 400: thinking.signature invalid'),
      {
        statusCode: 400,
        code: 'HTTP_400',
        response: {
          data: {
            error: {
              message: 'Bad Request: thinking.signature',
              type: 'invalid_request_error'
            }
          }
        }
      }
    );
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies mimoweb local harvest/contract failures as health-neutral unrecoverable local errors', () => {
    const samples = [
      '[mimoweb] upstream assistant response was empty',
      '[mimoweb] upstream emitted tool markers but no tool calls could be harvested',
      '[mimoweb] upstream repeated prior tool call after tool_result',
      '[mimoweb] serialized query exceeds empty-safe limit'
    ];

    for (const reason of samples) {
      const error = new Error(reason);
      const classification = resolveProviderFailureClassification({
        error,
        stage: 'provider.send',
        reason
      });

      expect(classification).toBe('unrecoverable');
      expect(resolveProviderFailureActionPlan({
        error,
        stage: 'provider.send',
        reason,
        attempt: 1,
        maxAttempts: 6
      })).toEqual(expect.objectContaining({
        classification: 'unrecoverable',
        affectsHealth: false,
        shouldRetry: false,
        action: 'direct_return',
        decisionLabel: 'direct_return'
      }));
    }
  });

  it('classifies invalid_request_error tool-history 2013 as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(
      new Error('invalid params, tool call result does not follow tool call (2013)'),
      {
        statusCode: 400,
        code: 'HTTP_400',
        response: {
          data: {
            error: {
              message: 'invalid params, tool call result does not follow tool call (2013)',
              type: 'invalid_request_error',
              code: 'HTTP_400'
            }
          }
        }
      }
    );
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies bare HTTP_400 bad request as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(new Error('HTTP 400: {"error":{"message":"bad request"}}'), {
      statusCode: 400,
      code: 'HTTP_400'
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies bare HTTP_400 missing input payload errors as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(new Error('Invalid request payload: missing field "input"'), {
      statusCode: 400,
      code: 'HTTP_400'
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies unknown bare HTTP_400 payload errors as recoverable provider failures', () => {
    const error = Object.assign(new Error('HTTP 400: upstream rejected request for unknown reason'), {
      statusCode: 400,
      code: 'HTTP_400'
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message
    });

    expect(classification).toBe('recoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'HTTP_400',
      reason: error.message,
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('classifies INVALID_REQUEST_ERROR code path as health-neutral unrecoverable local errors', () => {
    const error = Object.assign(new Error('invalid request payload'), {
      statusCode: 400,
      code: 'INVALID_REQUEST_ERROR',
      upstreamCode: 'INVALID_REQUEST_ERROR'
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'INVALID_REQUEST_ERROR',
      upstreamCode: 'INVALID_REQUEST_ERROR',
      reason: 'invalid request payload'
    });

    expect(classification).toBe('unrecoverable');
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'INVALID_REQUEST_ERROR',
      upstreamCode: 'INVALID_REQUEST_ERROR',
      reason: 'invalid request payload',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'unrecoverable',
      affectsHealth: false,
      shouldRetry: false,
      action: 'direct_return',
      decisionLabel: 'direct_return'
    }));
  });

  it('classifies provider business error 2013 context overflow as recoverable and health-affecting', () => {
    const error = Object.assign(new Error('provider business error: context_length_exceeded'), {
      code: 'MALFORMED_RESPONSE',
      statusCode: 400,
      details: {
        detected: 'provider_business_error',
        reason: 'context_length_exceeded',
        upstreamCode: 'context_length_exceeded',
        providerStatusCode: 2013
      }
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'MALFORMED_RESPONSE',
      reason: 'provider business error: context_length_exceeded'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'MALFORMED_RESPONSE',
      statusCode: 400,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'MALFORMED_RESPONSE',
      reason: 'provider business error: context_length_exceeded',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('classifies HTTP_429_2013 as recoverable and health-affecting', () => {
    const error = Object.assign(new Error('provider business error 2013'), {
      code: 'HTTP_429_2013',
      upstreamCode: 'HTTP_429_2013',
      statusCode: 429
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 429,
      errorCode: 'HTTP_429_2013',
      upstreamCode: 'HTTP_429_2013',
      reason: 'provider business error 2013'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      errorCode: 'HTTP_429_2013',
      upstreamCode: 'HTTP_429_2013',
      statusCode: 429,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 429,
      errorCode: 'HTTP_429_2013',
      upstreamCode: 'HTTP_429_2013',
      reason: 'provider business error 2013',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('RED: classifies non-malformed PROVIDER_STATUS_2013 traffic saturation as recoverable and health-affecting', () => {
    const error = Object.assign(new Error('Token Plan 当前请求量较高，请稍后重试'), {
      code: 'PROVIDER_STATUS_2013',
      upstreamCode: 'PROVIDER_STATUS_2013',
      statusCode: 200
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'PROVIDER_STATUS_2013',
      upstreamCode: 'PROVIDER_STATUS_2013',
      reason: 'Token Plan 当前请求量较高，请稍后重试'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      error,
      errorCode: 'PROVIDER_STATUS_2013',
      upstreamCode: 'PROVIDER_STATUS_2013',
      statusCode: 200,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'PROVIDER_STATUS_2013',
      upstreamCode: 'PROVIDER_STATUS_2013',
      reason: 'Token Plan 当前请求量较高，请稍后重试',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('classifies local network error ECONNRESET as recoverable via unified catalog', () => {
    const error = Object.assign(new Error('fetch failed: socket hang up'), {
      code: 'ECONNRESET'
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      errorCode: 'ECONNRESET',
      reason: 'fetch failed: socket hang up'
    });
    expect(classification).toBe('recoverable');
  });

  it('classifies provider_status_2056 as recoverable via unified catalog', () => {
    const error = Object.assign(new Error('usage limit exceeded'), {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_2056',
      statusCode: 429
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 429,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_2056',
      reason: 'usage limit exceeded'
    });
    expect(classification).toBe('recoverable');
  });

  it('RED: classifies provider business error 2013 traffic saturation as recoverable', () => {
    const error = Object.assign(
      new Error('Token Plan 当前请求量较高，请稍后重试'),
      {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2013',
        statusCode: 200,
        details: {
          detected: 'provider_business_error',
          upstreamCode: 'PROVIDER_STATUS_2013',
          providerStatusCode: 2013,
          reason: 'token plan 当前请求量较高，请稍后重试'
        }
      }
    );
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2013',
      reason: 'Token Plan 当前请求量较高，请稍后重试'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      error,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2013',
      statusCode: 200,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2013',
      reason: 'Token Plan 当前请求量较高，请稍后重试',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true
    }));
  });

  it('keeps provider failure classification space closed to 3 categories', () => {
    const samples = [
      resolveProviderFailureClassification({
        error: Object.assign(new Error('invalid token'), { statusCode: 401, code: 'INVALID_API_KEY' }),
        stage: 'provider.send',
        statusCode: 401,
        errorCode: 'INVALID_API_KEY'
      }),
      resolveProviderFailureClassification({
        error: Object.assign(new Error('fetch failed'), { statusCode: 502, code: 'HTTP_502' }),
        stage: 'provider.send',
        statusCode: 502,
        errorCode: 'HTTP_502'
      }),
      resolveProviderFailureClassification({
        error: Object.assign(new Error('context length exceeded'), { statusCode: 400, code: 'CONTEXT_LENGTH_EXCEEDED' }),
        stage: 'provider.send',
        statusCode: 400,
        errorCode: 'CONTEXT_LENGTH_EXCEEDED'
      })
    ];
    for (const classification of samples) {
      expect(['recoverable', 'unrecoverable']).toContain(classification);
    }
  });

  it('does not let promptTooLong bypass unified recoverable reroute action', () => {
    const error = Object.assign(new Error('Request input tokens exceeds the model maximum context length'), {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      statusCode: 400
    });

    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      reason: 'Request input tokens exceeds the model maximum context length',
      attempt: 1,
      maxAttempts: 6,
      promptTooLong: true
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));

    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 400,
      errorCode: 'CONTEXT_LENGTH_EXCEEDED',
      reason: 'Request input tokens exceeds the model maximum context length',
      attempt: 1,
      maxAttempts: 6,
      promptTooLong: true,
      contextOverflowRetries: 99,
      maxContextOverflowRetries: 1
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      blockingRecoverable: false,
      shouldRetry: true
    }));

    expect(resolveProviderFailureActionPlan({
      error: new Error('context exceeded'),
      stage: 'provider.send',
      statusCode: 400,
      reason: 'context exceeded',
      attempt: 1,
      maxAttempts: 6,
      promptTooLong: true,
      contextOverflowRetries: 99,
      maxContextOverflowRetries: 1
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      blockingRecoverable: false,
      shouldRetry: true
    }));
  });

  it('classifies sqlite busy 500 as recoverable and health-affecting', () => {
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
    })).toBe(false);
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
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('classifies short-lived 429 as recoverable and health-affecting', () => {
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
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.http',
      statusCode: 429,
      reason: 'HTTP 429: transient limit',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
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
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('treats transport fetch failed as recoverable blocking reroute', () => {
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
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('marks upstream headers timeout as recoverable but health-affecting', () => {
    const error = Object.assign(new Error('upstream headers timeout'), {
      code: 'UPSTREAM_HEADERS_TIMEOUT',
      statusCode: 504
    });
    const plan = resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 504,
      errorCode: 'UPSTREAM_HEADERS_TIMEOUT',
      reason: 'upstream headers timeout',
      attempt: 1,
      maxAttempts: 6
    });

    expect(plan).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative'
    }));
  });

  it('treats provider_status_1000 520 malformed-response wrapper as recoverable and health-affecting', () => {
    const error = Object.assign(new Error('[hub_response] upstream returned unknown error, 520'), {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_1000',
      statusCode: 520
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 520,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_1000',
      reason: '[hub_response] upstream returned unknown error, 520'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      error,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_1000',
      statusCode: 520,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 520,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_1000',
      reason: '[hub_response] upstream returned unknown error, 520',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative',
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('treats OpenAI-compatible SSE server_error payload as recoverable and health-affecting', () => {
    const error = Object.assign(new Error('[provider] Upstream provider returned business error: server_error'), {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'server_error',
      statusCode: 200
    });
    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'server_error',
      reason: '[provider] Upstream provider returned business error: server_error'
    });

    expect(classification).toBe('recoverable');
    expect(isProviderFailureHealthNeutral({
      stage: 'provider.send',
      error,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'server_error',
      statusCode: 200,
      classification
    })).toBe(false);
    expect(resolveProviderFailureActionPlan({
      error,
      stage: 'provider.send',
      statusCode: 200,
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'server_error',
      reason: '[provider] Upstream provider returned business error: server_error',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      affectsHealth: true,
      blockingRecoverable: false,
      shouldRetry: true,
      action: 'reroute_explicit_alternative'
    }));
  });

  it('supports provider-scoped reroute decision labels from the shared policy', () => {
    expect(resolveProviderFailureActionPlan({
      error: Object.assign(new Error('HTTP 502: upstream temporary unavailable'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'HTTP_502',
      upstreamCode: 'HTTP_502',
      reason: 'HTTP 502: upstream temporary unavailable',
      attempt: 1,
      maxAttempts: 6
    })).toEqual(expect.objectContaining({
      decisionLabel: 'exclude_and_reroute'
    }));
  });

  it('keeps host/followup stages outside provider policy classification', () => {
    expect(resolveProviderFailureClassification({
      error: new Error('followup failed'),
      stage: 'provider.followup',
      statusCode: 502,
      reason: 'followup failed'
    })).toBeUndefined();

    expect(resolveProviderFailureClassification({
      error: new Error('response contract violated'),
      stage: 'host.response_contract',
      statusCode: 502,
      reason: 'response contract violated'
    })).toBeUndefined();
  });

  it('loads native failure policy via bridge and classifies recoverable upstream failures', () => {
    const classification = resolveProviderFailureClassification({
      error: Object.assign(new Error('HTTP 502: upstream temporary unavailable'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'HTTP_502',
      upstreamCode: 'HTTP_502',
      reason: 'HTTP 502: upstream temporary unavailable'
    });

    expect(classification).toBe('recoverable');
  });

  it('treats host.response_contract 502 as health-affecting (non-neutral)', () => {
    expect(isProviderFailureHealthNeutral({
      stage: 'host.response_contract',
      errorCode: 'EMPTY_ASSISTANT_RESPONSE',
      statusCode: 502,
      classification: undefined
    })).toBe(false);
  });
});
