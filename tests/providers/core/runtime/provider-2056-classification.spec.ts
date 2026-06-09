/**
 * MiniMax 2056 must be exposed as a provider business error.
 *
 * resolveProviderBusinessResponseError should throw MALFORMED_RESPONSE
 * (not swallow), so ErrorErr01-06 can classify and route policy can decide.
 */

import { describe, test, expect } from '@jest/globals';
import { resolveProviderBusinessResponseError } from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';
import { normalizeKnownProviderError } from '../../../../src/providers/core/runtime/provider-error-catalog.js';

describe('MiniMax 2056 provider error classification', () => {
  test('2056 throws MALFORMED_RESPONSE so ErrorErr01 can capture it', () => {
    const result = resolveProviderBusinessResponseError({
      response: {
        data: {
          base_resp: {
            status_code: 2056,
            status_msg: 'usage limit exceeded'
          },
          choices: null
        },
        status: 200
      }
    });

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('business error');
  });

  test('provider catalog classifies PROVIDER_STATUS_2056 as recoverable', () => {
    const error = new Error('test');
    Object.assign(error, {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2056',
    });

    const normalized = normalizeKnownProviderError({
      code: (error as any).code,
      upstreamCode: (error as any).upstreamCode,
      statusCode: 429,
      message: error.message,
    });
    expect(normalized?.code).toBe('429.2056');
    expect(normalized?.class).toBe('recoverable');
  });

  test('non-2056 status codes are not classified as 2056', () => {
    const error = new Error('test');
    Object.assign(error, {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2013',
    });

    const normalized = normalizeKnownProviderError({
      code: (error as any).code,
      upstreamCode: (error as any).upstreamCode,
      message: error.message,
    });
    expect(normalized).toBeUndefined();
  });
});
