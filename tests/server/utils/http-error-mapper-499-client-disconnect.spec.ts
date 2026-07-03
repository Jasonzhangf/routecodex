import { mapErrorToHttp, ClientDisconnectHttpProjectionError } from '../../../src/server/utils/http-error-mapper.js';

function expectClientDisconnectSentinel(args: unknown): void {
  let thrown: unknown;
  try {
    mapErrorToHttp(args);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ClientDisconnectHttpProjectionError);
}

describe('http-error-mapper 499 client-disconnect suppression', () => {
  it('throws ClientDisconnectHttpProjectionError (no client body) when upstream body signals client abort', () => {
    expectClientDisconnectSentinel({
      message: 'HTTP 499: {"error":{"code":"HTTP_499","status":499}}',
      code: 'HTTP_499',
      status: 499,
      statusCode: 499,
      requestId: 'openai-responses-router-gpt-5.4-20260614T085154756-341633-1419',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
      providerType: 'openai',
      routeName: 'coding',
      response: {
        data: {
          error: {
            code: 'HTTP_499',
            status: 499,
            message: 'client abort request',
          },
        },
      },
      details: {
        upstreamCode: 'HTTP_499',
        upstreamMessage: 'client abort request',
        providerKey: 'asxs.crsa.gpt-5.4-mini',
      },
    });
  });

  it('throws ClientDisconnectHttpProjectionError when message contains client abort request', () => {
    expectClientDisconnectSentinel({
      message: 'client abort request',
      code: 'HTTP_499',
      status: 499,
      requestId: 'req_test_499_abort',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
    });
  });

  it('ordinary 4xx now requires exhaustion marker before projection', () => {
    const payloadWithoutMarker = mapErrorToHttp({
      message: 'HTTP 400: bad params',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_400',
      providerKey: 'p.q.model',
    });
    expect(payloadWithoutMarker.status).toBe(400);
    expect(payloadWithoutMarker.body.error.message).toBe('bad params');

    const payload = mapErrorToHttp({
      message: 'HTTP 400: bad params',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_400_exhausted',
      providerKey: 'p.q.model',
      details: { policyExhausted: true },
    });
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('bad params');
  });
});
