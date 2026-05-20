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
    expect(mapped.body?.error?.message).toContain('Upstream SSE decode failed');
    expect(mapped.body?.error?.request_id).toBe('req_test_sparse_http');
  });
});
