import { describe, expect, it } from '@jest/globals';
import { normalizeKnownProviderError } from '../../../../src/providers/core/runtime/provider-error-catalog.js';

describe('provider error catalog normalization', () => {
  it('normalizes upstream invalid-token messages to access-token catalog identity', () => {
    const normalized = normalizeKnownProviderError({
      statusCode: 401,
      code: 'HTTP_401',
      message: 'Invalid token (request id: redacted)'
    });

    expect(normalized?.code).toBe('401.1002');
    expect(normalized?.key).toBe('INVALID_ACCESS_TOKEN');
  });

  it('normalizes upstream quota text under 403 to quota catalog identity', () => {
    const normalized = normalizeKnownProviderError({
      statusCode: 403,
      code: 'HTTP_403',
      message: '{"error":{"message":"quota exceeded","code":"insufficient_quota"}}'
    });

    expect(normalized?.code).toBe('429.2000');
    expect(normalized?.key).toBe('INSUFFICIENT_QUOTA');
  });

  it('normalizes provider_status_2056 to unified numeric code', () => {
    const normalized = normalizeKnownProviderError({ upstreamCode: 'provider_status_2056', statusCode: 429 });
    expect(normalized?.code).toBe('429.2056');
    expect(normalized?.class).toBe('recoverable');
  });

  it('normalizes daily 429 text to quota depletion code', () => {
    const normalized = normalizeKnownProviderError({ statusCode: 429, message: 'daily usage limit exceeded' });
    expect(normalized?.code).toBe('429.2000');
    expect(normalized?.class).toBe('unrecoverable');
  });

  it('normalizes daily 429 text through the provider catalog', () => {
    const err = Object.assign(new Error('daily usage limit exceeded'), { statusCode: 429, code: 'HTTP_429' });
    const normalized = normalizeKnownProviderError({
      statusCode: err.statusCode,
      code: err.code,
      message: err.message
    });
    expect(normalized?.code).toBe('429.2000');
    expect(normalized?.class).toBe('unrecoverable');
  });

  it('normalizes model capacity text without status to retryable HTTP_429', () => {
    const normalized = normalizeKnownProviderError({
      message: 'Selected model is at capacity. Please try a different model.'
    });

    expect(normalized?.code).toBe('429.1000');
    expect(normalized?.key).toBe('HTTP_429');
    expect(normalized?.status).toBe(429);
    expect(normalized?.class).toBe('recoverable');
  });

  it('normalizes unknown HTTP 5xx provider status as recoverable', () => {
    const normalized = normalizeKnownProviderError({
      statusCode: 524,
      code: 'HTTP_524',
      message: 'HTTP 524: upstream timed out',
    });
    expect(normalized?.key).toBe('HTTP_5XX');
    expect(normalized?.class).toBe('recoverable');
  });
});
