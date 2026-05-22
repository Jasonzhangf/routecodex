import { afterEach, describe, expect, it } from '@jest/globals';
import {
  computeProviderFailureBackoffDelayMs,
  resolveProviderFailureClassification,
  resolveProviderFailureExclusionDecision,
} from '../../../../src/providers/core/runtime/provider-failure-policy.js';

describe('provider failure backoff windsurf stream cancel', () => {
  /**
   * Reference boundary:
   * - `/Volumes/extension/code/WindsurfAPI` is the only truth source for Windsurf alignment.
   * - RouteCodex must only preserve pure cascade cancel semantics here:
   *   `pending stream has been canceled` / `ERR_HTTP2_STREAM_CANCEL`.
   * - Only pure cascade transport wording may remain in active tests.
   */
  afterEach(() => {
    delete process.env.ROUTECODEX_WINDSURF_STREAM_CANCEL_BACKOFF_BASE_MS;
    delete process.env.RCC_WINDSURF_STREAM_CANCEL_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_WINDSURF_STREAM_CANCEL_BACKOFF_MAX_MS;
    delete process.env.RCC_WINDSURF_STREAM_CANCEL_BACKOFF_MAX_MS;
  });

  it('uses dedicated provider backoff instead of generic network backoff for ERR_HTTP2_STREAM_CANCEL', () => {
    const error = Object.assign(new Error('The pending stream has been canceled'), {
      code: 'ERR_HTTP2_STREAM_CANCEL',
      upstreamCode: 'ERR_HTTP2_STREAM_CANCEL'
    });

    const delayMs = computeProviderFailureBackoffDelayMs({
      scope: 'provider',
      error,
      consecutive: 2
    });

    expect(delayMs).toBe(2000);
  });

  it('treats pure cascade cancel wording as reroute-worthy transport failure', () => {
    const error = Object.assign(
      new Error('cascade transport: The pending stream has been canceled (caused by: )'),
      {
        statusCode: 502,
      }
    );

    const classification = resolveProviderFailureClassification({
      error,
      stage: 'provider.send',
      statusCode: 502,
      reason: 'cascade transport: The pending stream has been canceled (caused by: )',
    });

    expect(classification).toBe('recoverable');
    expect(resolveProviderFailureExclusionDecision({
      classification,
      statusCode: 502,
      errorCode: undefined,
      upstreamCode: undefined,
      promptTooLong: false,
      hasAlternativeCandidate: true,
      is429: false,
      isVerify: false,
      isReauth: false,
      isProviderTrafficSaturated: false,
      isNetworkTransport: false,
      reason: 'cascade transport: The pending stream has been canceled (caused by: )',
    } as any)).toEqual({
      excludeCurrentProvider: true,
      retryAction: 'reroute_explicit_alternative'
    });
  });
});
