import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshotMock = jest.fn(async () => undefined);

describe('router-direct failure snapshots', () => {
  beforeEach(() => {
    writeProviderSnapshotMock.mockClear();
  });

  it('captures provider-response error write on router-direct failure', async () => {
    const { captureRouterDirectFailureSnapshots } = await import('../../../../src/server/runtime/http-server/router-direct-failure-snapshot.js');

    const requestId = 'req_router_direct_failure_snapshot';
    const providerKey = 'XL-deepseek.key1.deepseek-v4-flash';
    const providerId = 'XL-deepseek';
    const entryEndpoint = '/v1/chat/completions';

    await captureRouterDirectFailureSnapshots({
      requestId,
      error: Object.assign(new Error('HTTP 520: upstream provider error'), {
        code: 'HTTP_520',
        statusCode: 520,
      }),
      entryEndpoint,
      entryPort: 4444,
      providerKey,
      providerId,
      metadata: { sessionId: 'router-direct-failure-snapshot' },
    }, writeProviderSnapshotMock as never);

    expect(writeProviderSnapshotMock).toHaveBeenCalledTimes(1);
    expect(writeProviderSnapshotMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'provider-response',
      requestId,
      entryEndpoint,
      entryPort: 4444,
      providerKey,
      providerId,
      forceLocalDiskWriteWhenDisabled: true,
      data: {
        error: expect.objectContaining({
          name: 'Error',
          message: 'HTTP 520: upstream provider error',
        }),
      },
    }));
  });

  it('does not write provider-request snapshot when failure happens before request capture', async () => {
    const { captureRouterDirectFailureSnapshots } = await import('../../../../src/server/runtime/http-server/router-direct-failure-snapshot.js');

    await captureRouterDirectFailureSnapshots({
      requestId: 'req_router_direct_failure_early',
      error: new Error('HTTP 400: upstream provider error'),
      entryEndpoint: '/v1/chat/completions',
      entryPort: 4444,
      providerKey: 'XL-deepseek.key1.deepseek-v4-flash',
      providerId: 'XL-deepseek',
    }, writeProviderSnapshotMock as never);

    expect(writeProviderSnapshotMock).toHaveBeenCalledTimes(1);
    expect(writeProviderSnapshotMock.mock.calls[0]?.[0]).toMatchObject({
      phase: 'provider-response',
      entryPort: 4444,
      forceLocalDiskWriteWhenDisabled: true,
    });
  });
});
