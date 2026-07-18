/**
 * Pure decision helpers for router-direct / provider-direct consumer.
 *
 * This module is intentionally framework-free so it can be unit-tested without
 * spinning up the HTTP server. The onProviderError consumers in
 * `http-server/index.ts` delegate the "should I request a recursive reroute,
 * or rethrow, or pass through?" decision to these helpers.
 *
 * Owner: `error.execution_decision_consumer`
 * Source anchor: `// feature_id: error.execution_decision_consumer`
 *
 * Contract (locked at 2026-06-14):
 *   - `client_disconnect` (HTTP_499 + "client abort request" / CLIENT_DISCONNECTED):
 *       decision is `rethrow` with `mutatedExcluded = new Set()`. The original
 *       error is allowed to flow to http-error-mapper, which projects it to
 *       HTTP 204 + CLIENT_DISCONNECTED code. The "no cooldown" guarantee is
 *       delivered upstream by `isProviderFailureHealthNeutral(args) === true`,
 *       NOT by this consumer.
 *   - `exclude_and_reroute` plan:
 *       decision is `request_reroute` with `mutatedExcluded` containing the
 *       current provider key. If ErrorErr05 explicitly allows switching
 *       beyond the numeric attempt budget, that provider switch still wins.
 *   - no retryable plan OR attempt budget exhausted
 *       without ErrorErr05 budget override:
 *       decision is `rethrow` with `mutatedExcluded = new Set()`.
 *   - provider auth/quota failures (401/402/403/INVALID_API_KEY/etc.):
 *       same as any other provider execution failure. If ErrorErr05 says the
 *       pool still has candidates, request reroute; only exhausted policy may
 *       reach client projection.
 */

import { isClientDisconnectLikeError as isClientDisconnectLikeErrorTs } from './direct-client-disconnect.js';

function isClientDisconnectLikeError(error: unknown): boolean {
  return isClientDisconnectLikeErrorTs(error);
}

export type DirectRetryAction = 'request_reroute' | 'rethrow';

export interface DirectRetryDecision {
  readonly action: DirectRetryAction;
  readonly shouldRecurse: boolean;
  readonly shouldRethrow: boolean;
  readonly mutatedExcluded: Set<string>;
  readonly error: unknown;
}

export interface DirectRetryPlanLike {
  shouldRetry?: boolean;
  retrySwitchPlan?: { switchAction?: string } | null | undefined;
  excludedCurrentProvider?: boolean;
  allowRetryBeyondAttemptBudget?: boolean;
  routePoolRemainingAfterExclusion?: readonly string[];
  defaultPoolAvailable?: boolean;
  policyExhausted?: boolean;
  mayProject?: boolean;
  routeName?: string;
}

export interface DecideDirectRouterRetryArgs {
  retryExecutionPlan: DirectRetryPlanLike;
  excludedProviderKeys: Set<string>;
  directAttempt: number;
  maxAttempts: number;
  providerKey: string;
  error: unknown;
  routeName?: string;
}

function newExcluded(excluded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(excluded);
  next.add(key);
  return next;
}

function readPlanRemainingRouteCandidateCount(plan: DirectRetryPlanLike): number | undefined {
  if (!Array.isArray(plan.routePoolRemainingAfterExclusion)) {
    return undefined;
  }
  return plan.routePoolRemainingAfterExclusion.filter((candidate) => (
    typeof candidate === 'string' && candidate.trim().length > 0
  )).length;
}

function isExplicitDirectRoute(plan: DirectRetryPlanLike, routeName?: string): boolean {
  const effectiveRouteName = typeof routeName === 'string' && routeName.trim()
    ? routeName.trim()
    : (typeof plan.routeName === 'string' ? plan.routeName.trim() : '');
  return effectiveRouteName === 'direct';
}

function rethrowDecision(error: unknown, excluded: ReadonlySet<string>): DirectRetryDecision {
  return {
    action: 'rethrow',
    shouldRecurse: false,
    shouldRethrow: true,
    mutatedExcluded: new Set(excluded),
    error,
  };
}

function requestRerouteDecision(
  error: unknown,
  excluded: ReadonlySet<string>,
  mutated: ReadonlySet<string>
): DirectRetryDecision {
  return {
    action: 'request_reroute',
    shouldRecurse: true,
    shouldRethrow: false,
    mutatedExcluded: new Set(mutated),
    error,
  };
}

export function decideDirectRouterRetry(args: DecideDirectRouterRetryArgs): DirectRetryDecision {
  const {
    retryExecutionPlan,
    excludedProviderKeys,
    directAttempt,
    maxAttempts,
    providerKey,
    error,
    routeName,
  } = args;

  // Reverse 1: client_disconnect. Caller rethrows so http-error-mapper
  // can project it to 204 / CLIENT_DISCONNECTED. We do NOT mutate
  // excludedProviderKeys; we do NOT request reroute.
  if (isClientDisconnectLikeError(error)) {
    return rethrowDecision(error, excludedProviderKeys);
  }

  // Reverse 2: no retryable plan at all.
  if (
    !retryExecutionPlan.shouldRetry
    || !retryExecutionPlan.retrySwitchPlan
    || (
      retryExecutionPlan.retrySwitchPlan.switchAction !== 'exclude_and_reroute'
    )
  ) {
    return rethrowDecision(error, excludedProviderKeys);
  }

  // Reverse 3: attempt budget exhausted unless ErrorErr05 explicitly allows
  // provider switching beyond the numeric attempt cap.
  if (directAttempt >= maxAttempts && retryExecutionPlan.allowRetryBeyondAttemptBudget !== true) {
    return rethrowDecision(error, excludedProviderKeys);
  }

  const excluded = retryExecutionPlan.excludedCurrentProvider
    ? newExcluded(excludedProviderKeys, providerKey)
    : new Set(excludedProviderKeys);
  const remainingCandidates = readPlanRemainingRouteCandidateCount(retryExecutionPlan);
  if (remainingCandidates === undefined) {
    return rethrowDecision(error, excludedProviderKeys);
  }
  if (remainingCandidates <= 0) {
    if (isExplicitDirectRoute(retryExecutionPlan, routeName)) {
      return rethrowDecision(error, excludedProviderKeys);
    }
    if (
      retryExecutionPlan.defaultPoolAvailable === true
      && retryExecutionPlan.mayProject !== true
    ) {
      return requestRerouteDecision(error, excludedProviderKeys, excluded);
    }
    return rethrowDecision(error, excludedProviderKeys);
  }
  return requestRerouteDecision(error, excludedProviderKeys, excluded);
}

export interface DecideDirectProviderRetryArgs {
  retryExecutionPlan: DirectRetryPlanLike;
  error: unknown;
  providerKey: string;
}

/**
 * Provider-direct has no route-pool expansion today; the contract is simpler:
 * it never requests a synthetic recursive reroute on its own, and never
 * mutates excludedProviderKeys. The unified ErrorErr05 plan is consumed only
 * to decide whether to log a switch telemetry, never to fabricate a retry
 * attempt.
 */
export function decideDirectProviderRetry(args: DecideDirectProviderRetryArgs): DirectRetryDecision {
  const { error, retryExecutionPlan, providerKey } = args;
  if (isClientDisconnectLikeError(error)) {
    return rethrowDecision(error, new Set());
  }
  if (retryExecutionPlan.mayProject === true && retryExecutionPlan.policyExhausted === true) {
    return rethrowDecision(error, new Set());
  }
  if (
    retryExecutionPlan.shouldRetry
    && retryExecutionPlan.retrySwitchPlan?.switchAction === 'exclude_and_reroute'
    && retryExecutionPlan.excludedCurrentProvider === true
    && retryExecutionPlan.mayProject !== true
  ) {
    return requestRerouteDecision(error, new Set(), new Set(providerKey ? [providerKey] : []));
  }
  return rethrowDecision(error, new Set());
}

export { isClientDisconnectLikeError };
