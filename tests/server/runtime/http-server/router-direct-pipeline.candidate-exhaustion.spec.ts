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
 *   5. (reverse) no recoverable plan (e.g. `special_400`) → must NOT
 *      request retry; caller may receive the original error.
 *   6. (forward) provider auth/quota errors with a reroute plan are still
 *      provider-switching opportunities until route/default pools are empty.
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

  it('[forward] exclude_and_reroute with remaining attempts → request reroute', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
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

  it('[forward] exhausted current pool with defaultPoolAvailable=true → request reroute into VR default planner', () => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan({
        routePoolRemainingAfterExclusion: [],
        defaultPoolAvailable: true,
        policyExhausted: false,
        mayProject: false,
      } as Partial<Plan>),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1'],
      error: { code: 'HTTP_401', statusCode: 401, message: 'auth failed' },
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
    expect(decision.shouldRethrow).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set(['p1']));
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

  it.each([
    ['HTTP_401', { statusCode: 401, status: 401, code: 'HTTP_401', message: 'Upstream authentication failed' }],
    ['HTTP_403', { statusCode: 403, status: 403, code: 'HTTP_403', message: 'Upstream access denied' }],
    ['INVALID_API_KEY', { statusCode: 401, code: 'INVALID_API_KEY', message: 'invalid api key' }],
    ['INSUFFICIENT_QUOTA', { statusCode: 429, code: 'INSUFFICIENT_QUOTA', message: 'insufficient quota' }],
    ['ACCOUNT_DISABLED', { statusCode: 403, code: 'ACCOUNT_DISABLED', message: 'account disabled' }],
  ])('[forward] %s with reroute plan and remaining candidate → request reroute', (_label, error) => {
    const decision = decideDirectRouterRetry({
      retryExecutionPlan: plan(),
      excludedProviderKeys: new Set(),
      directAttempt: 1,
      maxAttempts: 3,
      providerKey: 'p1',
      pool: ['p1', 'p2'],
      error,
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
    expect(decision.shouldRethrow).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set(['p1']));
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
