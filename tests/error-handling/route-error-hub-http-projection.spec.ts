import { describe, expect, it } from '@jest/globals';

describe('RouteErrorHub includeHttpResult client-disconnect guard', () => {
  it('suppresses non-projectable client-disconnect http projection instead of throwing', async () => {
    const { initializeRouteErrorHub, reportRouteError } = await import('../../src/error-handling/route-error-hub.js');

    initializeRouteErrorHub({
      errorHandlingCenter: {
        async initialize() {},
        async handleError() {},
      } as never
    });

    const result = await reportRouteError({
      code: 'HTTP_499',
      message: 'client abort request',
      source: 'test',
      scope: 'http',
      requestId: 'req_route_error_hub_499',
      details: { status: 499, upstreamCode: 'HTTP_499', upstreamMessage: 'client abort request' },
      originalError: Object.assign(new Error('client abort request'), {
        code: 'HTTP_499',
        status: 499,
        statusCode: 499,
      })
    }, { includeHttpResult: true });

    expect(result.http).toBeUndefined();
  });
});
