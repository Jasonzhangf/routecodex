/**
 * Red test for `hasAlternativeRouteCandidate` semantics used by
 * `request-executor-retry-decision.ts`. Locks the contract that an empty
 * `routePool` MUST be treated as "no alternative candidates" (not "any
 * candidate available"). This is required by:
 *   - docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md
 *     §0.5 (rule 3 + 6): 候选耗尽才允许 ErrorErr06ClientProjected；
 *     empty routePool must be classified as candidate exhausted.
 *   - docs/error-handling-v2.md §1.0 ErrorErr06ClientProjected 前置门。
 *
 * Source anchor: `// feature_id: error.execution_decision_consumer`
 * Owner: src/server/runtime/http-server/executor/request-executor-retry-decision.ts
 */

import { describe, expect, it } from '@jest/globals';
import {
  hasAlternativeRouteCandidate
} from '../../../../src/server/runtime/http-server/executor/request-executor-retry-decision.js';

describe('hasAlternativeRouteCandidate — empty routePool is candidate exhausted', () => {
  it('[forward] explicit routePool with non-excluded alternative → true', () => {
    const result = hasAlternativeRouteCandidate({
      providerKey: 'p1',
      routePool: ['p1', 'p2', 'p3'],
      excludedProviderKeys: new Set(['p1'])
    });
    expect(result).toBe(true);
  });

  it('[reverse] empty routePool → false (no alternative, candidate exhausted)', () => {
    const result = hasAlternativeRouteCandidate({
      providerKey: 'p1',
      routePool: [],
      excludedProviderKeys: new Set(['p1'])
    });
    expect(result).toBe(false);
  });

  it('[reverse] all candidates excluded → false', () => {
    const result = hasAlternativeRouteCandidate({
      providerKey: 'p1',
      routePool: ['p1', 'p2'],
      excludedProviderKeys: new Set(['p1', 'p2'])
    });
    expect(result).toBe(false);
  });

  it('[forward] only-current-provider routePool → false', () => {
    const result = hasAlternativeRouteCandidate({
      providerKey: 'p1',
      routePool: ['p1'],
      excludedProviderKeys: new Set()
    });
    expect(result).toBe(false);
  });

  it('[forward] alternative exists even when providerKey is undefined', () => {
    const result = hasAlternativeRouteCandidate({
      providerKey: undefined,
      routePool: ['p1', 'p2'],
      excludedProviderKeys: new Set(['p1'])
    });
    expect(result).toBe(true);
  });
});
