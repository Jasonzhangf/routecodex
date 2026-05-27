/**
 * Red-test: MiniMax 2056 must be digested at the provider shaping layer.
 *
 * resolveProviderBusinessResponseError should return undefined for 2056
 * (not throw MALFORMED_RESPONSE), so the error never reaches the
 * classification/retry layer. 2056 = transient upstream rotation.
 */

import { describe, test, expect } from '@jest/globals';
import { resolveProviderBusinessResponseError } from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';
import { resolveProviderFailureClassification } from '../../../../src/providers/core/runtime/provider-failure-policy-impl.js';

describe('MiniMax 2056 absorption', () => {
  test('2056 returns undefined (no error = absorbed)', () => {
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

    // RED: before fix, this threw MALFORMED_RESPONSE
    // GREEN: after fix, returns undefined (digested)
    expect(result).toBeUndefined();
  });

  test('non-zero non-2056 status_code still throws', () => {
    const result = resolveProviderBusinessResponseError({
      response: {
        data: {
          base_resp: {
            status_code: 2013,
            status_msg: 'context length exceeded'
          },
          choices: null
        },
        status: 200
      }
    });

    // Other non-zero codes still throw
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('business error');
  });

  test('zero status_code returns undefined (success)', () => {
    const result = resolveProviderBusinessResponseError({
      response: {
        data: {
          base_resp: {
            status_code: 0,
            status_msg: ''
          },
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }]
        },
        status: 200
      }
    });

    expect(result).toBeUndefined();
  });

  test('2056 never reaches classification layer', () => {
    // Since 2056 is absorbed at shaping layer, classification shouldn't see it.
    // This tests that if it somehow still surfaces, it's classified correctly.
    const result = resolveProviderFailureClassification({
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2056',
      reason: 'usage limit exceeded',
      statusCode: 200,
    });

    // Keep as recoverable — transient, not permanent
    expect(result).toBe('recoverable');
    expect(result).not.toBe('unrecoverable');
  });
});
