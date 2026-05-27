import { describe, expect, it } from '@jest/globals';

describe('retry-engine uses unified provider error catalog', () => {
  it('treats daily 429 as non-retryable', async () => {
    const { isRetryableSseWrapperError } = await import(
      '../../../../../src/server/runtime/http-server/executor/retry-engine.js'
    );

    expect(
      isRetryableSseWrapperError('daily usage limit exceeded', 'HTTP_429', 429)
    ).toBe(false);
  });

  it('treats provider_status_2056 as retryable', async () => {
    const { isRetryableSseWrapperError } = await import(
      '../../../../../src/server/runtime/http-server/executor/retry-engine.js'
    );

    expect(
      isRetryableSseWrapperError('usage limit exceeded', 'provider_status_2056', 429)
    ).toBe(true);
  });

  it('treats local network error hints as retryable', async () => {
    const { isRetryableSseWrapperError } = await import(
      '../../../../../src/server/runtime/http-server/executor/retry-engine.js'
    );

    expect(
      isRetryableSseWrapperError('socket hang up', 'ECONNRESET', 502)
    ).toBe(true);
  });
});
