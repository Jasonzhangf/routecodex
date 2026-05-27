import { describe, expect, it } from '@jest/globals';

describe('request-retry helpers unified error catalog behavior', () => {
  it('treats daily 429 as non-retryable for sse decode', async () => {
    const { isSseDecodeRateLimitError } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );
    expect(
      isSseDecodeRateLimitError(
        {
          code: 'HTTP_429',
          upstreamCode: 'HTTP_429',
          message: 'daily usage limit exceeded',
        },
        429,
      ),
    ).toBe(false);
  });

  it('treats provider_status_2056 as retryable for sse decode', async () => {
    const { isSseDecodeRateLimitError } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );
    expect(
      isSseDecodeRateLimitError(
        {
          code: 'MALFORMED_RESPONSE',
          upstreamCode: 'provider_status_2056',
          message: 'usage limit exceeded',
        },
        429,
      ),
    ).toBe(true);
  });

  it('treats local ECONNRESET as retryable network for sse decode wrapper', async () => {
    const { isSseDecodeRetryableNetworkError } = await import(
      '../../../../../src/server/runtime/http-server/executor/request-retry-helpers.js'
    );
    expect(
      isSseDecodeRetryableNetworkError(
        {
          code: 'ECONNRESET',
          message: 'socket hang up',
        },
        502,
      ),
    ).toBe(true);
  });
});
