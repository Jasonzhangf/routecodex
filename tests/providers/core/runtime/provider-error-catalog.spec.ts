import { describe, expect, it } from '@jest/globals';
import { normalizeKnownProviderError } from '../../../../src/providers/core/runtime/provider-error-catalog.js';
import { resolveAutoRetryErrorCode } from '../../../../src/providers/core/runtime/auto-retry-error-codes.js';

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

  it('maps through resolveAutoRetryErrorCode via catalog first', () => {
    const err = Object.assign(new Error('daily usage limit exceeded'), { statusCode: 429, code: 'HTTP_429' });
    expect(resolveAutoRetryErrorCode(err)).toBe('429.2000');
  });
});
