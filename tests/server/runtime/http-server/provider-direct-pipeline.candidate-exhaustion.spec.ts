/**
 * Real red/green tests for provider-direct candidate-exhaustion contract.
 *
 * Provider-direct must consume the unified ErrorErr05 decision instead of doing
 * a raw 4xx/5xx early projection. The minimal contract is:
 *   1. client_disconnect → rethrow original error for final 204 projection,
 *      with no excluded-provider mutation.
 *   2. mayProject=false + defaultPoolAvailable=true → request reroute/re-entry,
 *      not rethrow.
 *   3. mayProject=false + routePoolRemainingAfterExclusion non-empty →
 *      request reroute/re-entry, not rethrow.
 *   4. mayProject=true + policyExhausted=true → rethrow/project is allowed.
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
    routePoolRemainingAfterExclusion: ['p2'],
    defaultPoolAvailable: false,
    policyExhausted: false,
    mayProject: false,
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

  it('[forward] current pool exhausted but defaultPoolAvailable=true → request reroute/re-entry, not rethrow', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: plan({
        routePoolRemainingAfterExclusion: [],
        defaultPoolAvailable: true,
        policyExhausted: false,
        mayProject: false,
      }),
      error: { code: 'PROVIDER_TRANSPORT', message: 'upstream 5xx' },
      providerKey: 'p1',
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
    expect(decision.shouldRethrow).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set(['p1']));
  });

  it('[forward] routePoolRemainingAfterExclusion non-empty → request reroute/re-entry, not rethrow', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: plan({
        routePoolRemainingAfterExclusion: ['p2'],
        defaultPoolAvailable: false,
        policyExhausted: false,
        mayProject: false,
      }),
      error: { statusCode: 503, code: 'HTTP_503', message: 'upstream unavailable' },
      providerKey: 'p1',
    });
    expect(decision.action).toBe('request_reroute');
    expect(decision.shouldRecurse).toBe(true);
    expect(decision.shouldRethrow).toBe(false);
    expect(decision.mutatedExcluded).toEqual(new Set(['p1']));
  });

  it('[reverse] mayProject=true + policyExhausted=true → rethrow/project allowed', () => {
    const decision = decideDirectProviderRetry({
      retryExecutionPlan: {
        shouldRetry: false,
        retrySwitchPlan: undefined,
        excludedCurrentProvider: true,
        routePoolRemainingAfterExclusion: [],
        defaultPoolAvailable: false,
        policyExhausted: true,
        mayProject: true,
      } as Plan,
      error: { code: 'HTTP_503', message: 'all candidates exhausted' },
      providerKey: 'p1',
    });
    expect(decision.action).toBe('rethrow');
    expect(decision.shouldRecurse).toBe(false);
  });
});
