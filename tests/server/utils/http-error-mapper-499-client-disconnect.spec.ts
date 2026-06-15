import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper 499 client-disconnect suppression', () => {
  it('does not return upstream 499 + body to client when upstream body signals client abort', () => {
    const payload = mapErrorToHttp({
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
    // Client-visible 499 must not leak to caller. 499 means "Client Closed Request" and is
    // a transport cancellation, not a client-valid error.
    expect(payload.status).not.toBe(499);
    expect(payload.body.error.message.toLowerCase()).not.toContain('client abort request');
    expect(payload.body.error.message.toLowerCase()).not.toContain('upstream rejected');
    // No provider cooldown side-effect signal: code is a neutral client-disconnect marker.
    expect(payload.body.error.code).toBe('CLIENT_DISCONNECTED');
  });

  it('does not return upstream 499 when message contains client abort request', () => {
    const payload = mapErrorToHttp({
      message: 'client abort request',
      code: 'HTTP_499',
      status: 499,
      requestId: 'req_test_499_abort',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
    });
    expect(payload.status).not.toBe(499);
    expect(payload.body.error.message.toLowerCase()).not.toContain('client abort request');
    expect(payload.body.error.code).toBe('CLIENT_DISCONNECTED');
  });

  it('keeps ordinary 4xx (e.g. 400) on the rejection path', () => {
    const payload = mapErrorToHttp({
      message: 'HTTP 400: bad params',
      code: 'HTTP_400',
      status: 400,
      requestId: 'req_test_400',
      providerKey: 'p.q.model',
    });
    expect(payload.status).toBe(400);
    expect(payload.body.error.message).toBe('Upstream rejected the request');
  });
});
