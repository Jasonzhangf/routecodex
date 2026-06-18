import { describe, expect, it, jest } from '@jest/globals';

const mockReportRouteError = jest.fn();

jest.unstable_mockModule('../../../src/error-handling/route-error-hub.js', () => ({
  reportRouteError: mockReportRouteError
}));

const { resolveReportedRouteErrorHttpResponse } = await import(
  '../../../src/server/handlers/handler-utils.js'
);

describe('resolveReportedRouteErrorHttpResponse', () => {
  it('falls back to local mapped payload when error hub returns malformed sparse http payload', async () => {
    mockReportRouteError.mockResolvedValueOnce({
      http: {
        status: 502,
        body: {
          error: {
            code: 'HTTP_502'
          }
        }
      }
    });

    const normalizedError = Object.assign(new Error('Upstream SSE decode failed: timeout'), {
      code: 'HTTP_502',
      status: 502,
      upstreamCode: 'UPSTREAM_STREAM_TIMEOUT'
    }) as Error & Record<string, unknown>;

    const mapped = await resolveReportedRouteErrorHttpResponse({
      routePayload: {
        code: 'HTTP_502',
        message: normalizedError.message,
        source: 'http-handler./v1/responses',
        scope: 'http',
        requestId: 'req_test_sparse_http',
        endpoint: '/v1/responses',
        originalError: normalizedError
      },
      normalizedError
    });

    expect(mapped.status).toBe(504);
    expect(mapped.body?.error?.code).toBe('HTTP_502');
    expect(mapped.body?.error?.message).toBe('Upstream request timed out');
    expect(mapped.body?.error?.request_id).toBe('req_test_sparse_http');
  });

  it('sanitizes provider auth payload even when error hub returns a valid unsafe http payload', async () => {
    mockReportRouteError.mockResolvedValueOnce({
      http: {
        status: 401,
        body: {
          error: {
            code: 'new_api_error',
            message: 'Invalid token (request id: 202606071512465023321438268d9d6fRB1TBuk)',
            request_id: 'req_test_unsafe_http'
          }
        }
      }
    });

    const normalizedError = Object.assign(
      new Error(
        'HTTP 401: {"error":{"code":"","message":"Invalid token (request id: 202606071512465023321438268d9d6fRB1TBuk)","type":"new_api_error"}}'
      ),
      {
        code: 'HTTP_401',
        status: 401,
        statusCode: 401,
        rawErrorSnippet:
          '{"error":{"code":"new_api_error","message":"Invalid token (request id: 202606071512465023321438268d9d6fRB1TBuk)","type":"new_api_error"}}'
      }
    ) as Error & Record<string, unknown>;

    const mapped = await resolveReportedRouteErrorHttpResponse({
      routePayload: {
        code: 'HTTP_401',
        message: normalizedError.message,
        source: 'http-handler./v1/responses',
        scope: 'http',
        requestId: 'req_test_unsafe_http',
        endpoint: '/v1/responses',
        originalError: normalizedError
      },
      normalizedError
    });

    const publicJson = JSON.stringify(mapped.body);
    expect(mapped.status).toBe(502);
    expect(mapped.body?.error?.code).toBe('upstream_error');
    expect(mapped.body?.error?.message).toBe('Upstream provider error');
    expect(mapped.body?.error?.request_id).toBeUndefined();
    expect(publicJson).not.toContain('Invalid token');
    expect(publicJson).not.toContain('202606071512465023321438268d9d6fRB1TBuk');
    expect(publicJson).not.toContain('new_api_error');
    expect(publicJson).not.toContain('HTTP_401');
  });

  it('sanitizes provider quota payload for forced SSE error responses', async () => {
    mockReportRouteError.mockResolvedValueOnce({
      http: {
        status: 403,
        body: {
          error: {
            code: 'insufficient_quota',
            message: '余额和订阅额度均不足，请充值后再使用',
            request_id: 'req_test_sse_unsafe_http'
          }
        }
      }
    });

    const writes: string[] = [];
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers[name] = value;
        return this;
      },
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      end() {
        return this;
      }
    };

    const { respondWithPipelineError } = await import('../../../src/server/handlers/handler-utils.js');
    await respondWithPipelineError(
      res as never,
      {} as never,
      Object.assign(
        new Error(
          'HTTP 403: {"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}'
        ),
        {
          code: 'HTTP_403',
          status: 403,
          statusCode: 403,
          rawErrorSnippet:
            '{"error":{"message":"余额和订阅额度均不足，请充值后再使用","type":"permission_error","code":"insufficient_quota"}}'
        }
      ),
      '/v1/responses',
      'req_test_sse_unsafe_http',
      { forceSse: true }
    );

    const rendered = writes.join('');
    expect(res.statusCode).toBe(502);
    expect(rendered).toContain('event: error');
    expect(rendered).toContain('Upstream provider error');
    expect(rendered).toContain('upstream_error');
    expect(rendered).not.toContain('Upstream authentication failed');
    expect(rendered).not.toContain('HTTP_403');
    expect(rendered).not.toContain('req_test_sse_unsafe_http');
    expect(rendered).not.toContain('余额和订阅额度均不足');
    expect(rendered).not.toContain('insufficient_quota');
    expect(rendered).not.toContain('permission_error');
  });
});
