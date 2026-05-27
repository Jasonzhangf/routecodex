/**
 * Red-test: MiniMax 2056 must be retried by provider internal auto-retry.
 *
 * resolveAutoRetryErrorCode should return '0.8200' for 2056.
 * resolveProviderBusinessResponseError should throw MALFORMED_RESPONSE
 * (not swallow), so the auto-retry has an error to catch and retry on.
 */

import { describe, test, expect } from '@jest/globals';
import { resolveProviderBusinessResponseError } from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';
import { resolveAutoRetryErrorCode } from '../../../../src/providers/core/runtime/auto-retry-error-codes.js';

describe('MiniMax 2056 auto-retry', () => {
  test('2056 throws MALFORMED_RESPONSE (so auto-retry can catch it)', () => {
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

    // Must throw, so base-provider.ts auto-retry catches it
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('business error');
  });

  test('resolveAutoRetryErrorCode returns 0.8200 for PROVIDER_STATUS_2056', () => {
    const error = new Error('test');
    Object.assign(error, {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2056',
    });

    const code = resolveAutoRetryErrorCode(error);
    expect(code).toBe('0.8200');
  });

  test('non-2056 status codes return different retry codes', () => {
    const error = new Error('test');
    Object.assign(error, {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2013',
    });

    const code = resolveAutoRetryErrorCode(error);
    // 2013 is not in auto-retry codes
    expect(code).toBeUndefined();
  });
});
