import {
  mapErrorToHttp,
  project_error_err_06_client_from_error_err_05_execution_decision,
} from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper policy-exhausted gate', () => {
  it('[forward] provider 5xx without exhausted marker cannot enter ErrorErr06 projection', () => {
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision({
      message: 'HTTP 502: upstream unavailable',
      code: 'HTTP_502',
      status: 502,
      statusCode: 502,
      requestId: 'req_test_unexhausted',
      providerKey: 'p.q.model',
    })).toThrow(/policy\/candidate exhaustion/);
  });

  it('[forward] provider 4xx without exhausted marker cannot enter ErrorErr06 projection', () => {
    expect(() => project_error_err_06_client_from_error_err_05_execution_decision({
      message: 'bad params',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_400_unexhausted',
      providerKey: 'p.q.model',
    })).toThrow(/policy\/candidate exhaustion/);
  });

  it('[reverse] detailed upstream 4xx with exhausted marker still projects correctly', () => {
    const payload = project_error_err_06_client_from_error_err_05_execution_decision({
      message: 'HTTP 400: upstream rejected payload',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_exhausted',
      providerKey: 'p.q.model',
      details: { policyExhausted: true, upstreamCode: 'HTTP_400', upstreamMessage: 'model not found' },
    });
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('Upstream rejected the request');
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

  it('[reverse] client_disconnect projects to 204 without exhausted marker', () => {
    const payload = project_error_err_06_client_from_error_err_05_execution_decision({
      message: 'HTTP 499: {"error":{"message":"client abort request"}}',
      code: 'HTTP_499',
      status: 499,
      requestId: 'req_client_abort',
    });
    expect(payload.status).toBe(204);
    expect(payload.body.error.code).toBe('CLIENT_DISCONNECTED');
  });
});
