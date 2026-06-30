import {
  resolveProviderFailureClassification,
  resolveProviderFailureOutcome,
} from '../../../../src/providers/core/runtime/provider-failure-policy-impl.js';

describe('provider-failure-policy upstream_stream_incomplete', () => {
  it('[forward] classifies upstream_stream_incomplete as recoverable so direct/relay can reroute', () => {
    const classification = resolveProviderFailureClassification({
      error: {
        message: 'stream closed before response.completed',
        code: 'UPSTREAM_STREAM_INCOMPLETE',
        statusCode: 502,
      },
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'UPSTREAM_STREAM_INCOMPLETE',
      upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE',
      reason: 'stream closed before response.completed',
    });
    expect(classification).toBe('recoverable');
  });

  it('[forward] upstream_stream_incomplete stays health-neutral while remaining recoverable', () => {
    const outcome = resolveProviderFailureOutcome({
      error: {
        message: 'stream closed before response.completed',
        code: 'UPSTREAM_STREAM_INCOMPLETE',
        statusCode: 502,
      },
      stage: 'provider.send',
      statusCode: 502,
      errorCode: 'UPSTREAM_STREAM_INCOMPLETE',
      upstreamCode: 'UPSTREAM_STREAM_INCOMPLETE',
      reason: 'stream closed before response.completed',
    });
    expect(outcome.recoverable).toBe(true);
    expect(outcome.affectsHealth).toBe(false);
  });
});
