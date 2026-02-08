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
