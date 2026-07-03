import { describe, expect, it } from '@jest/globals';
import {
  decideDirectRouterRetry,
  type DecideDirectRouterRetryArgs,
} from '../../../../src/server/runtime/http-server/direct-decision.js';

function buildArgs(overrides: Partial<DecideDirectRouterRetryArgs> = {}): DecideDirectRouterRetryArgs {
  return {
    retryExecutionPlan: {
      shouldRetry: true,
      retrySwitchPlan: {
        switchAction: 'exclude_and_reroute',
        reason: 'recoverable',
      },
      excludedCurrentProvider: true,
    },
    excludedProviderKeys: new Set<string>(),
    directAttempt: 1,
    maxAttempts: 6,
    providerKey: '1token.key1.gpt-5.4-mini',
    pool: ['1token.key1.gpt-5.4-mini', 'cc.key1.gpt-5.4-mini', 'sdfv.key1.gpt-5.4-mini'],
    error: Object.assign(new Error('stream closed before response.completed'), {
      code: 'UPSTREAM_STREAM_INCOMPLETE',
      statusCode: 502,
    }),
    ...overrides,
  };
}

describe('direct-decision upstream_stream_incomplete', () => {
  it('[forward] stream incomplete must be classified as recoverable and request reroute (not rethrow)', () => {
    const decision = decideDirectRouterRetry(buildArgs());
    expect(decision.action).toBe('request_reroute');
    expect(decision.mutatedExcluded.has('1token.key1.gpt-5.4-mini')).toBe(true);
    expect(decision.mutatedExcluded.has('cc.key1.gpt-5.4-mini')).toBe(false);
  });

  it('[reverse] stream incomplete with no ErrorErr05 switch plan must rethrow (no host-injected fallback)', () => {
    const decision = decideDirectRouterRetry(buildArgs({
      pool: ['1token.key1.gpt-5.4-mini'],
      excludedProviderKeys: new Set<string>(['1token.key1.gpt-5.4-mini']),
      retryExecutionPlan: {
        shouldRetry: false,
      },
    }));
    expect(decision.action).toBe('rethrow');
  });

  it('[forward] ErrorErr05 exclude_and_reroute must recurse even when observed router-direct pool is current-only', () => {
    const decision = decideDirectRouterRetry(buildArgs({
      pool: ['1token.key1.gpt-5.4-mini'],
      retryExecutionPlan: {
        shouldRetry: true,
        retrySwitchPlan: {
          switchAction: 'exclude_and_reroute',
          reason: 'recoverable',
        },
        excludedCurrentProvider: true,
        routePoolRemainingAfterExclusion: ['cc.key1.gpt-5.4-mini'],
      },
    }));
    expect(decision.action).toBe('request_reroute');
    expect(decision.mutatedExcluded.has('1token.key1.gpt-5.4-mini')).toBe(true);
  });
});
