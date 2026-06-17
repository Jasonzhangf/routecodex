import { mapErrorToPublicLogSummary } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper client_disconnect log summary', () => {
  it('[forward] mapErrorToPublicLogSummary never echoes raw upstream 499 / HTTP 499 / client abort request text', () => {
    const args = {
      message: 'HTTP 499: {"error":{"code":"HTTP_499","status":499}}',
      code: 'HTTP_499',
      status: 499,
      statusCode: 499,
      requestId: 'req_log_499',
      providerKey: 'asxs.crsa.gpt-5.4-mini',
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
    };
    const summary = mapErrorToPublicLogSummary(args, 'a-fallback');
    expect(summary).toMatch(/client_disconnect=true/);
    expect(summary).not.toContain('HTTP 499');
    expect(summary.toLowerCase()).not.toContain('client abort request');
  });

  it('[reverse] ordinary 5xx log summary still surfaces upstream provider error fallback', () => {
    const args = {
      message: 'HTTP 502: upstream unavailable',
      code: 'HTTP_502',
      status: 502,
      requestId: 'req_log_502',
      providerKey: 'p.q.model',
    };
    const summary = mapErrorToPublicLogSummary(args, 'a-fallback');
    expect(summary).toBe('a-fallback');
  });
});
