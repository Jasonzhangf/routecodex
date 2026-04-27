import { describe, expect, it } from '@jest/globals';

describe('RouteErrorHub initialization guard', () => {
  it('reportRouteError before initializeRouteErrorHub throws explicit no-fallback error', async () => {
    const {
      reportRouteError,
      getRouteErrorHub,
      RouteErrorHubNotInitializedError
    } = await import('../../src/error-handling/route-error-hub.js');

    await expect(reportRouteError({
      code: 'test_uninitialized',
      message: 'testing route error hub initialization guard',
      source: 'test',
      scope: 'other'
    })).rejects.toBeInstanceOf(RouteErrorHubNotInitializedError);

    expect(getRouteErrorHub()).toBeNull();
  });
});
