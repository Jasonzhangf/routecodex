import {
  isEarlyProjectionBlockedError,
  mapErrorToHttp,
  project_error_err_06_client_from_error_err_05_execution_decision,
} from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper policy-exhausted gate', () => {
  function decision(overrides: Record<string, unknown> = {}) {
    return {
      message: 'HTTP 502: upstream unavailable',
      code: 'HTTP_502',
      status: 502,
      statusCode: 502,
      requestId: 'req_test',
      providerKey: 'p.q.model',
      routePoolRemainingAfterExclusion: [],
      defaultPoolAvailable: false,
      policyExhausted: true,
      mayProject: true,
      ...overrides,
    };
  }

  it('[forward] ErrorErr05 mayProject=false cannot enter ErrorErr06 projection', () => {
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision({
      ...decision({
        requestId: 'req_test_unexhausted',
        routePoolRemainingAfterExclusion: ['p2'],
        policyExhausted: false,
        mayProject: false,
      }),
    })).toThrow(/ErrorErr05 decision is not projectable/);
  });

  it('[forward] ErrorErr05 defaultPoolAvailable=true cannot enter ErrorErr06 projection even when route pool is exhausted', () => {
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision(decision({
      requestId: 'req_test_default_pool_available',
      routePoolRemainingAfterExclusion: [],
      defaultPoolAvailable: true,
      policyExhausted: false,
      mayProject: false,
    }))).toThrow(/ErrorErr05 decision is not projectable/);
  });

  it('[forward] mapErrorToHttp remains a pure 4xx projector outside ErrorErr06 gating', () => {
    const args = {
      message: 'bad params',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_g7_unexhausted',
      providerKey: 'p.q.model',
      details: { policyExhausted: false, candidateExhausted: false },
    };
    const payload = mapErrorToHttp(args);
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('Upstream rejected the request');
  });

  it('[reverse] mapErrorToHttp 4xx with policyExhausted=true still projects correctly', () => {
    const args = {
      message: 'model not found',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_g7_exhausted',
      providerKey: 'p.q.model',
      details: { policyExhausted: true, upstreamCode: 'HTTP_400' },
    };
    const payload = mapErrorToHttp(args);
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('Upstream rejected the request');
  });

  it('[reverse] detailed upstream 4xx with exhausted marker still projects correctly', () => {
    const payload = project_error_err_06_client_from_error_err_05_execution_decision(decision({
      message: 'HTTP 400: upstream rejected payload',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_exhausted',
      providerKey: 'p.q.model',
      details: { policyExhausted: true, upstreamCode: 'HTTP_400', upstreamMessage: 'model not found' },
    }));
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('model not found');
  });

  it('[reverse] special_400 always projects regardless of exhaustion', () => {
    const payload = mapErrorToHttp({
      message: 'tool call arguments malformed',
      code: 'MALFORMED_REQUEST',
      status: 400,
      requestId: 'req_malformed',
    });
    expect(payload.status).toBe(400);
    expect(payload.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('[reverse] client_disconnect must NOT project any HTTP status code or body (non-projectable sentinel)', () => {
    // Per docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md §0.4:
    // client_disconnect = server stop request + keep disconnect, no 204 body, no CLIENT_DISCONNECTED JSON.
    const args = {
      message: 'HTTP 499: {"error":{"message":"client abort request"}}',
      code: 'HTTP_499',
      status: 499,
      requestId: 'req_client_abort',
    };
    expect(() => mapErrorToHttp(args)).toThrow(/client_disconnect/i);
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision(decision(args)))
      .toThrow(/client_disconnect/i);
  });

  it('[reverse] legacy details.policyExhausted alone is not a valid ErrorErr05 decision', () => {
    try {
      project_error_err_06_client_from_error_err_05_execution_decision({
        message: 'HTTP 502: upstream unavailable',
        code: 'HTTP_502',
        status: 502,
        requestId: 'req_legacy_marker_only',
        providerKey: 'p.q.model',
        details: { policyExhausted: true },
      } as any);
      throw new Error('legacy marker unexpectedly projected');
    } catch (error) {
      expect(isEarlyProjectionBlockedError(error)).toBe(true);
    }
  });
});
