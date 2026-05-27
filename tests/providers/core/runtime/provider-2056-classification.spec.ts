/**
 * Red-test: MiniMax 2056 usage limit should be classified as unrecoverable.
 *
 * Before fix: resolveProviderFailureClassification returned 'recoverable'
 *   → retry_same_provider on exhausted quota → infinite loop
 * After fix:  returns 'unrecoverable' → trip provider with cooldown → failover
 */

import { describe, test, expect } from '@jest/globals';
import { resolveProviderFailureClassification } from '../../../../src/providers/core/runtime/provider-failure-policy-impl.js';

describe('MiniMax 2056 classification', () => {
  test('2056 + MALFORMED_RESPONSE → unrecoverable (NOT recoverable)', () => {
    const result = resolveProviderFailureClassification({
      errorCode: 'MALFORMED_RESPONSE',
      upstreamCode: 'PROVIDER_STATUS_2056',
      reason: 'usage limit exceeded',
      statusCode: 200,
    });

    // RED: before fix this returned 'recoverable'
    // GREEN: after fix returns 'unrecoverable'
    expect(result).toBe('unrecoverable');
    expect(result).not.toBe('recoverable');
  });

  test('2056 via nestedCode path → unrecoverable', () => {
    const result = resolveProviderFailureClassification({
      errorCode: 'MALFORMED_RESPONSE',
      nestedCode: 'PROVIDER_STATUS_2056',
      reason: 'upstream business error: usage limit exceeded',
      statusCode: 200,
    });

    expect(result).toBe('unrecoverable');
  });

  test('2056 via reason text path → unrecoverable', () => {
    const result = resolveProviderFailureClassification({
      errorCode: 'MALFORMED_RESPONSE',
      reason: 'upstream returned: usage limit exceeded for provider mini27',
      statusCode: 200,
    });

    expect(result).toBe('unrecoverable');
  });

  test('non-2056 malformed response still unrecoverable', () => {
    // MALFORMED_RESPONSE without 2056 context should remain unrecoverable
    const result = resolveProviderFailureClassification({
      errorCode: 'MALFORMED_RESPONSE',
      reason: 'invalid JSON in response body',
      statusCode: 200,
    });

    expect(result).toBe('unrecoverable');
  });
});
