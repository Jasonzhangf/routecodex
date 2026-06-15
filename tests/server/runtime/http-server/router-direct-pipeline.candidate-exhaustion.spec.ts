/**
 * Real red/green tests for router-direct candidate-exhaustion contract.
 *
 * The 2026-06-14 design correction requires router-direct to:
 *   1. (forward) >=2 candidates + recoverable error → must NOT propagate the
 *      original error to the caller. Must request a recursive reroute.
 *   2. (forward) switchAction === 'exclude_and_reroute' with a non-disconnect
 *      error → same contract as above (must reroute, not rethrow).
 *   3. (reverse) only 1 candidate left + recoverable error → allowed fail-fast:
 *      caller receives the original error.
 *   4. (reverse) client_disconnect (HTTP_499 + 'client abort request') → caller
 *      receives the original error (so that http-error-mapper can project it
 *      to HTTP 204 / CLIENT_DISCONNECTED), but `directRetryRequested` must be
 *      false AND `excludedProviderKeys` must NOT have been mutated.
 *   5. (reverse) no recoverable plan (e.g. `special_400` / `401`) → must NOT
 *      request retry; caller may receive the original error.
 *
 * Owner: `decideDirectRouterRetry` in src/server/runtime/http-server/index.ts
 * Source anchor: `// feature_id: error.execution_decision_consumer`
 */

import { describe, expect, it, jest } from '@jest/globals';
import {
  decideDirectRouterRetry,
  isClientDisconnectLikeError,
} from '../../../../src/server/runtime/http-server/direct-decision.js';

type Plan = Parameters<typeof decideDirectRouterRetry>[0]['retryExecutionPlan'];

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

describe('router-direct.candidate-exhaustion', () => {
  it('[forward] exclude_and_reroute with >=2 candidates left → request reroute (no early-return guard)', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2', 'p3'],
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
    expect(decision.shouldRethrow).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set(['p1']));
  });

  it('[forward] retry_same_provider_once with remaining attempts → request reroute (same provider)', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan({
        retrySwitchPlan: { switchAction: 'retry_same_provider_once' } as Plan['retrySwitchPlan'],
      }),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2'],
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
  });

  it('[reverse] only 1 candidate left in pool → must NOT reroute, caller rethrows', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1'],
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRethrow).toBe(true);
    expect(decision.shouldRecurse).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set());
  });

  it('[reverse] client_disconnect → caller receives original error, NO excluded mutation, NO retry request', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2'],
      error: { status: 499, code: 'HTTP_499', message: 'client abort request' },
    });
    expect(isClientDisconnectLikeError(decision.error)).toBe(true);
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set());
  });

  it('[reverse] non-recoverable plan (special_400) → must NOT request retry', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: {
        shouldRetry: false,
        retrySwitchPlan: undefined,
        excludedCurrentProvider: false,
        requestLocalTransient: false,
        blockingRecoverable: false,
      } as Plan,
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2'],
      error: { code: 'special_400', message: 'malformed request' },
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set());
  });

  it('[reverse] attempt exhausted (directAttempt >= maxAttempts) → rethrow', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
      excludedProviderKeys: new Set(),
      directAttempt: 3,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2', 'p3'],
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
  });
});
