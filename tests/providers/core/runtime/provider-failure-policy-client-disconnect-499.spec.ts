import {
  resolveProviderFailureClassification,
  resolveProviderFailureOutcome,
  isProviderFailureClientDisconnect,
} from '../../../../src/providers/core/runtime/provider-failure-policy-impl.js';

describe('provider-failure-policy upstream 499 client-disconnect', () => {
  it('classifies upstream 499 + client abort request as not affectsHealth', () => {
    const error = {
      message: 'HTTP 499: {"error":{"code":"HTTP_499","status":499}}',
      code: 'HTTP_499',
      statusCode: 499,
      status: 499,
      details: {
        upstreamCode: 'HTTP_499',
        upstreamMessage: 'client abort request',
      },
    };
    const outcome = resolveProviderFailureOutcome({
      error,
      stage: 'provider.send',
      statusCode: 499,
      errorCode: 'HTTP_499',
      upstreamCode: 'HTTP_499',
      reason: 'client abort request',
    });
    expect(outcome.affectsHealth).toBe(false);
  });

  it('isProviderFailureClientDisconnect returns true for upstream 499 + client abort request', () => {
    const error = {
      message: 'HTTP 499: {"error":{"code":"HTTP_499","status":499}}',
      code: 'HTTP_499',
      statusCode: 499,
      details: { upstreamMessage: 'client abort request' },
    };
    expect(isProviderFailureClientDisconnect(error)).toBe(true);
  });

  it('isProviderFailureClientDisconnect returns true for upstream body client abort request alone', () => {
    const error = { message: 'client abort request' };
    expect(isProviderFailureClientDisconnect(error)).toBe(true);
  });

  it('ordinary 4xx is not a client disconnect', () => {
    const error = { message: 'bad params', code: 'HTTP_400', statusCode: 400 };
    expect(isProviderFailureClientDisconnect(error)).toBe(false);
  });
});
