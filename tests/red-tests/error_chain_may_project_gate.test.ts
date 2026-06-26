/**
 * ErrorErr05 mayProject gate red test.
 *
 * Locks the hard skeleton of `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`:
 *  - ErrorErr05ExecutionDecision MUST carry `routePoolRemainingAfterExclusion`,
 *    `defaultPoolAvailable`, `policyExhausted`, `mayProject`.
 *  - `mayProject` MUST be `true` ONLY when `routePoolRemainingAfterExclusion` is empty
 *    AND `defaultPoolAvailable` is `false`.
 *  - `callerMayProject(decision)` is the only client-projection predicate.
 *  - When the decision is not projectable, projection MUST throw
 *    `EARLY_PROJECTION_BLOCKED` (sentinel), not return a partial HTTP payload.
 *  - 401 / 403 / INVALID_API_KEY / INSUFFICIENT_QUOTA / ACCOUNT_DISABLED must
 *    continue to take the reroute path (excludedCurrentProvider true + shouldRetry
 *    is up to caller), not project a provider-visible 4xx.
 *  - client_disconnect remains health-neutral and non-projectable.
 *
 * Single owner: `error.execution_decision_consumer` + `error.client_projection`.
 */

import {
  resolveProviderRetryExecutionPlanExhaustionGate,
  ERROR_EXECUTION_DECISION_CONSUMER_FEATURE_ID,
} from '../../src/server/runtime/http-server/executor/request-executor-retry-execution-plan.js';
import {
  callerMayProject,
  EarlyProjectionBlockedError,
  isEarlyProjectionBlockedError,
  project_error_err_06_client_from_error_err_05_execution_decision,
} from '../../src/server/utils/http-error-mapper.js';
import { resolveProviderFailureExclusionDecision } from '../../src/providers/core/runtime/provider-failure-policy.js';

const FEATURE_ID = ERROR_EXECUTION_DECISION_CONSUMER_FEATURE_ID;

describe(`${FEATURE_ID} — ErrorErr05 mayProject gate`, () => {
  it('gate: pool has remaining candidate → mayProject=false even if classification=unrecoverable', () => {
    const decision = resolveProviderRetryExecutionPlanExhaustionGate({
      routePool: ['a', 'b'],
      excludedProviderKeys: new Set(['a']),
      defaultPoolAvailable: false,
    });
    expect(decision.routePoolRemainingAfterExclusion).toEqual(['b']);
    expect(decision.defaultPoolAvailable).toBe(false);
    expect(decision.policyExhausted).toBe(false);
    expect(decision.mayProject).toBe(false);
    expect(callerMayProject(decision)).toBe(false);
  });

  it('gate: pool empty BUT default pool available → mayProject=false (must reroute to default first)', () => {
    const decision = resolveProviderRetryExecutionPlanExhaustionGate({
      routePool: ['a'],
      excludedProviderKeys: new Set(['a']),
      defaultPoolAvailable: true,
    });
    expect(decision.routePoolRemainingAfterExclusion).toEqual([]);
    expect(decision.defaultPoolAvailable).toBe(true);
    expect(decision.policyExhausted).toBe(false);
    expect(decision.mayProject).toBe(false);
    expect(callerMayProject(decision)).toBe(false);
  });

  it('gate: pool empty AND default pool empty → mayProject=true (terminal)', () => {
    const decision = resolveProviderRetryExecutionPlanExhaustionGate({
      routePool: ['a'],
      excludedProviderKeys: new Set(['a']),
      defaultPoolAvailable: false,
    });
    expect(decision.routePoolRemainingAfterExclusion).toEqual([]);
    expect(decision.defaultPoolAvailable).toBe(false);
    expect(decision.policyExhausted).toBe(true);
    expect(decision.mayProject).toBe(true);
    expect(callerMayProject(decision)).toBe(true);
  });

  it('gate: no routePool at all (empty tier) AND no default → mayProject=true', () => {
    const decision = resolveProviderRetryExecutionPlanExhaustionGate({
      excludedProviderKeys: new Set(),
      defaultPoolAvailable: false,
    });
    expect(decision.routePoolRemainingAfterExclusion).toEqual([]);
    expect(decision.policyExhausted).toBe(true);
    expect(decision.mayProject).toBe(true);
  });

  it('callerMayProject rejects malformed decisions', () => {
    expect(callerMayProject(null)).toBe(false);
    expect(callerMayProject(undefined)).toBe(false);
    expect(callerMayProject({} as never)).toBe(false);
    expect(callerMayProject({ mayProject: true } as never)).toBe(false);
    expect(callerMayProject({ mayProject: true, policyExhausted: false, routePoolRemainingAfterExclusion: [], defaultPoolAvailable: false } as never)).toBe(false);
  });

  it('client projection throws EARLY_PROJECTION_BLOCKED when not projectable', () => {
    const nonProjectable = {
      mayProject: false,
      policyExhausted: false,
      routePoolRemainingAfterExclusion: ['a'],
      defaultPoolAvailable: false,
    };
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision(nonProjectable as never))
      .toThrow(EarlyProjectionBlockedError);
    try {
      project_error_err_06_client_from_error_err_05_execution_decision(nonProjectable as never);
    } catch (err) {
      expect(isEarlyProjectionBlockedError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('EARLY_PROJECTION_BLOCKED');
    }
  });

  it('client projection succeeds and returns HttpErrorPayload when mayProject=true', () => {
    const projectable = {
      mayProject: true,
      policyExhausted: true,
      routePoolRemainingAfterExclusion: [],
      defaultPoolAvailable: false,
    };
    const payload = project_error_err_06_client_from_error_err_05_execution_decision(projectable as never);
    expect(payload).toBeDefined();
    expect(payload.body.error).toBeDefined();
  });

  it('401 without alternative must not force exclusion by status shortcut alone', () => {
    const decision = resolveProviderFailureExclusionDecision({
      hasAlternativeCandidate: false,
    });
    expect(decision.excludeCurrentProvider).toBe(false);
  });

  it('403 and auth/quota codes with alternatives must still take exclusion+rerroute path', () => {
    const viaStatus = resolveProviderFailureExclusionDecision({
      hasAlternativeCandidate: true,
    });
    const viaInvalidApiKey = resolveProviderFailureExclusionDecision({
      hasAlternativeCandidate: true,
    });
    const viaInsufficientQuota = resolveProviderFailureExclusionDecision({
      hasAlternativeCandidate: true,
    });
    expect(viaStatus).toMatchObject({
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative',
    });
    expect(viaInvalidApiKey).toMatchObject({
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative',
    });
    expect(viaInsufficientQuota).toMatchObject({
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative',
    });
  });
});
