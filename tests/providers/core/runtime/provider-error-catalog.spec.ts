import { describe, expect, it } from '@jest/globals';
import { normalizeKnownProviderError } from '../../../../src/providers/core/runtime/provider-error-catalog.js';

describe('provider error catalog normalization', () => {
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
});
