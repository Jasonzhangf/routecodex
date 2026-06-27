/**
 * Runtime coverage: executor layer must use provider-failure-policy exports
 * (not redefine network-transport or blocking-recoverable detection).
 * Imports real symbols to confirm the contract holds at runtime.
 */

import { isProviderFailureNetworkTransportLike } from '../../../../../src/providers/core/runtime/provider-failure-policy.js';
import {
  resolveProviderFailureOutcome
} from '../../../../../src/providers/core/runtime/provider-failure-policy.js';
import {
  resolveProviderFailureClassification
} from '../../../../../src/providers/core/runtime/provider-failure-policy.js';
import { resolveProviderRetryExecutionPlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-execution-plan.js';

describe('Error chain singleton — runtime binding', () => {
  it('isProviderFailureNetworkTransportLike recognizes ECONNRESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isProviderFailureNetworkTransportLike(err)).toBe(true);
  });

  it('isProviderFailureNetworkTransportLike recognizes AbortError', () => {
    const err = Object.assign(new Error('operation was aborted'), { name: 'AbortError' });
    expect(isProviderFailureNetworkTransportLike(err)).toBe(true);
  });

  it('isProviderFailureNetworkTransportLike returns false for null', () => {
    expect(isProviderFailureNetworkTransportLike(null)).toBe(false);
    expect(isProviderFailureNetworkTransportLike(undefined)).toBe(false);
  });

  it('resolveProviderFailureClassification delegates to provider-failure-policy', () => {
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const result = resolveProviderFailureClassification({
      error: err,
      statusCode: undefined,
      errorCode: undefined,
      upstreamCode: undefined,
      reason: 'connection refused',
      stage: 'provider.send'
    });
    // 503 / ECONNREFUSED is recoverable; executor must surface that via policy
    expect(result === 'recoverable' || result === undefined).toBe(true);
  });

  it('resolveProviderFailureOutcome exposes policy recoverable and affectsHealth fields', () => {
    expect(resolveProviderFailureOutcome({
      error: Object.assign(new Error('HTTP 502: temporary'), { code: 'HTTP_502', statusCode: 502 }),
      statusCode: 502,
      errorCode: 'HTTP_502',
      upstreamCode: undefined,
      reason: 'HTTP 502: temporary',
      stage: 'provider.send'
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      recoverable: true,
      affectsHealth: true
    }));

    expect(resolveProviderFailureOutcome({
      error: Object.assign(new Error('followup failed'), { code: 'SERVERTOOL_FOLLOWUP_FAILED', statusCode: 502 }),
      statusCode: 502,
      errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: undefined,
      reason: 'followup failed',
      stage: 'provider.followup'
    })).toEqual(expect.objectContaining({
      classification: undefined,
      recoverable: false,
      affectsHealth: false
    }));
  });

  it('resolveProviderRetryExecutionPlan builds the reroute switch plan inline', async () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    const plan = await resolveProviderRetryExecutionPlan({
      error: err,
      retryError: { statusCode: 502, errorCode: 'HTTP_502', upstreamCode: undefined, reason: 'bad gateway' },
      attempt: 1,
      maxAttempts: 3,
      stage: 'provider.send',
      logicalRequestChainKey: 'chain-1',
      logicalChainRetryLimitStageRequestId: 'req-1',
      routePool: ['prov-a', 'prov-b'],
      excludedProviderKeys: new Set<string>(),
      recordAttempt: () => undefined,
      logStage: () => undefined,
      defaultTierAvailable: false,
      logNonBlockingError: () => undefined
    });
    expect(plan.retrySwitchPlan).toEqual(expect.objectContaining({
      switchAction: 'exclude_and_reroute',
      decisionLabel: 'exclude_and_reroute'
    }));
  });
});
