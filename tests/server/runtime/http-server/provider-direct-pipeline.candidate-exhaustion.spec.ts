/**
 * Real red/green tests for provider-direct candidate-exhaustion contract.
 *
 * Provider-direct has no route-pool expansion today, but its consumer still
 * must consume the unified ErrorErr05 decision instead of doing a raw 4xx early
 * projection. The minimal contract is:
 *   1. client_disconnect → rethrow original error for final 204 projection,
 *      with no excluded-provider mutation.
 *   2. only bound provider and recoverable error → rethrow original error
 *      (no synthetic reroute, no infinite loop).
 *   3. non-recoverable plan → rethrow original error.
 *
 * Owner: `decideDirectProviderRetry` in src/server/runtime/http-server/index.ts
 */

import { describe, expect, it } from '@jest/globals';
import {
  decideDirectProviderRetry,
  isClientDisconnectLikeError,
} from '../../../../src/server/runtime/http-server/direct-decision.js';

type Plan = Parameters<typeof decideDirectProviderRetry>[0]['retryExecutionPlan'];

function plan(over: Partial<Plan> = {}): Plan {
  return {
    shouldRetry: true,
    retrySwitchPlan: {
      switchAction: 'exclude_and_reroute',
    } as Plan['retrySwitchPlan'],
    excludedCurrentProvider: true,
    requestLocalTransient: true,
    blockingRecoverable: true,
    ...over,
  } as Plan;
}

describe('provider-direct.candidate-exhaustion', () => {
  it('[reverse] client_disconnect → caller receives original error; no synthetic retry / no mutation', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: plan(),
      error: { status: 499, code: 'HTTP_499', message: 'client abort request' },
      providerKey: 'p1',
    });
    expect(isClientDisconnectLikeError(decision.error)).toBe(true);
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set());
  });

  it('[reverse] recoverable error on single bound provider → rethrow original error', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: plan(),
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
      providerKey: 'p1',
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set());
  });

  it('[reverse] non-recoverable plan → rethrow original error', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: {
        shouldRetry: false,
        retrySwitchPlan: undefined,
        excludedCurrentProvider: false,
        requestLocalTransient: false,
        blockingRecoverable: false,
      } as Plan,
      error: { code: 'special_400', message: 'malformed request' },
      providerKey: 'p1',
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
  });
});
