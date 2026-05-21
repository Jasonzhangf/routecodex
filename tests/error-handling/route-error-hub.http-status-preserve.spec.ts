import { describe, expect, it, jest } from '@jest/globals';

describe('RouteErrorHub includeHttpResult preserves upstream http status', () => {
  it('keeps provider 501 instead of remapping it to 502 when includeHttpResult is enabled', async () => {
    const { initializeRouteErrorHub } = await import('../../src/error-handling/route-error-hub.js');

    const hub = initializeRouteErrorHub({
      errorHandlingCenter: {
        initialize: jest.fn().mockResolvedValue(undefined),
        handleError: jest.fn().mockResolvedValue({ success: true })
      } as any
    });

    const result = await hub.report({
      code: 'WINDSURF_CHAT_MAINLINE_UNVERIFIED',
      message: '[windsurf] verified cloud chat mainline for managed Windsurf credentials is not implemented',
      source: 'test',
      scope: 'provider',
      requestId: 'req-route-error-hub-501',
      details: {
        status: 501
      },
      originalError: Object.assign(
        new Error('[windsurf] verified cloud chat mainline for managed Windsurf credentials is not implemented'),
        {
          code: 'WINDSURF_CHAT_MAINLINE_UNVERIFIED',
          status: 501,
          statusCode: 501
        }
      )
    }, { includeHttpResult: true });

    expect(result.http).toMatchObject({
      status: 501,
      body: {
        error: {
          code: 'WINDSURF_CHAT_MAINLINE_UNVERIFIED',
          message: '[windsurf] verified cloud chat mainline for managed Windsurf credentials is not implemented',
          request_id: 'req-route-error-hub-501'
        }
      }
    });
  });
});
