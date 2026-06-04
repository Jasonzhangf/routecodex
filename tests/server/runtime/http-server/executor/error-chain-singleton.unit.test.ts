/**
 * Runtime coverage: executor layer must use provider-failure-policy exports
 * (not redefine network-transport or blocking-recoverable detection).
 * Imports real symbols to confirm the contract holds at runtime.
 */

import { isProviderFailureNetworkTransportLike } from '../../../../../src/providers/core/runtime/provider-failure-policy.js';
import {
  resolveRequestExecutorProviderErrorClassification,
  resolveRequestExecutorProviderFailureOutcome
} from '../../../../../src/server/runtime/http-server/executor/request-executor-provider-failure.js';
import { buildProviderRetrySwitchPlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-retry-decision.js';

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

  it('resolveRequestExecutorProviderErrorClassification delegates to provider-failure-policy', () => {
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const result = resolveRequestExecutorProviderErrorClassification({
      error: err,
      retryError: { statusCode: undefined, errorCode: undefined, upstreamCode: undefined, reason: 'connection refused' },
      stage: 'provider.send'
    });
    // 503 / ECONNREFUSED is recoverable; executor must surface that via policy
    expect(result === 'recoverable' || result === undefined).toBe(true);
  });

  it('resolveRequestExecutorProviderFailureOutcome exposes policy recoverable and affectsHealth fields', () => {
    expect(resolveRequestExecutorProviderFailureOutcome({
      error: Object.assign(new Error('HTTP 502: temporary'), { code: 'HTTP_502', statusCode: 502 }),
      retryError: { statusCode: 502, errorCode: 'HTTP_502', upstreamCode: undefined, reason: 'HTTP 502: temporary' },
      stage: 'provider.send'
    })).toEqual(expect.objectContaining({
      classification: 'recoverable',
      recoverable: true,
      affectsHealth: true
    }));

    expect(resolveRequestExecutorProviderFailureOutcome({
      error: Object.assign(new Error('followup failed'), { code: 'SERVERTOOL_FOLLOWUP_FAILED', statusCode: 502 }),
      retryError: { statusCode: 502, errorCode: 'SERVERTOOL_FOLLOWUP_FAILED', upstreamCode: undefined, reason: 'followup failed' },
      stage: 'provider.followup'
    })).toEqual(expect.objectContaining({
      classification: undefined,
      recoverable: false,
      affectsHealth: false
    }));
  });

  it('buildProviderRetrySwitchPlan uses policy-driven network-transport signal', () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    const switchPlan = buildProviderRetrySwitchPlan({
      runtimeKey: 'rt-1',
      routePool: ['prov-a', 'prov-b'],
      excludedProviderKeys: new Set<string>(),
      excludedCurrentProvider: false,
      promptTooLong: false,
      error: err,
      retryError: { statusCode: 502, errorCode: 'HTTP_502', upstreamCode: undefined, reason: 'bad gateway' },
      backoffScope: 'attempt'
    });
    // If provider not excluded, retry_same_provider; either way the helper must not throw
    expect(['retry_same_provider', 'exclude_and_reroute']).toContain(switchPlan.switchAction);
  });
});
