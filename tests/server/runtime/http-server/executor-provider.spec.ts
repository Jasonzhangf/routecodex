import { describeRetryReason, shouldRetryProviderError } from '../../../../src/server/runtime/http-server/executor-provider.js';

describe('executor-provider retry policy', () => {
  it('treats virtualRouterSeriesCooldown errors as retryable so router can pick next alias', () => {
    const error = Object.assign(new Error('quota exhausted'), {
      details: {
        virtualRouterSeriesCooldown: {
          cooldownMs: 1_000,
          source: 'quota_reset_delay',
          quotaResetDelay: '1s'
        }
      }
    });
    expect(shouldRetryProviderError(error)).toBe(true);
  });

  it('falls back to HTTP status heuristics when no cooldown hint exists', () => {
    const retriable = Object.assign(new Error('server error'), { statusCode: 502 });
    expect(shouldRetryProviderError(retriable)).toBe(true);

    const nonRetriable = Object.assign(new Error('client error'), { statusCode: 400 });
    expect(shouldRetryProviderError(nonRetriable)).toBe(false);
  });

  it('fails fast on deterministic context overflow errors', () => {
    const promptTooLong = Object.assign(new Error('context_length_exceeded: prompt is too long'), {
      statusCode: 400,
      code: 'context_length_exceeded'
    });
    expect(shouldRetryProviderError(promptTooLong)).toBe(false);
  });

  it('treats HTTP 413 payload-too-large as retryable for provider failover', () => {
    const payloadTooLarge = Object.assign(
      new Error('HTTP 413: {"error":{"message":"Exceeded limit on max bytes to request body : 6291456"}}'),
      { statusCode: 413, retryable: false }
    );
    expect(shouldRetryProviderError(payloadTooLarge)).toBe(true);
  });

  it('treats HTTP 401 unauthorized as retryable for provider failover', () => {
    const unauthorized = Object.assign(new Error('HTTP 401: Unauthorized'), {
      statusCode: 401,
      retryable: false
    });
    expect(shouldRetryProviderError(unauthorized)).toBe(true);
  });

  it('treats iflow business 514 model error as retryable', () => {
    const error = Object.assign(new Error('HTTP 400: iFlow business error (514): model error'), {
      statusCode: 400,
      providerFamily: 'iflow',
      response: {
        data: {
          error: {
            code: '514',
            message: 'model error'
          }
        }
      }
    });
    expect(shouldRetryProviderError(error)).toBe(true);
  });

  it('surface message from arbitrary error via describeRetryReason', () => {
    const error = Object.assign(new Error('something bad'), { statusCode: 500 });
    expect(describeRetryReason(error)).toContain('something bad');
  });

});
