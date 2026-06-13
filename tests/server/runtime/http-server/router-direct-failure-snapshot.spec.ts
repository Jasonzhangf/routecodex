import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshotMock = jest.fn(async () => undefined);

describe('router-direct failure snapshots', () => {
  beforeEach(() => {
    writeProviderSnapshotMock.mockClear();
  });

  it('captures provider-request and provider-response writes on router-direct failure', async () => {
    const {
      captureRouterDirectFailureSnapshots,
      captureRouterDirectProviderRequestSnapshot,
    } = await import('../../../../src/server/runtime/http-server/router-direct-failure-snapshot.js');

    const requestId = 'req_router_direct_failure_snapshot';
    const providerKey = 'XL-deepseek.key1.deepseek-v4-flash';
    const providerId = 'XL-deepseek';
    const entryEndpoint = '/v1/chat/completions';
    const payload = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'trigger failure snapshot' }],
    };

    await captureRouterDirectProviderRequestSnapshot({
      requestId,
      payload,
      entryEndpoint,
      providerKey,
      providerId,
      metadata: { sessionId: 'router-direct-failure-snapshot' },
    }, writeProviderSnapshotMock as never);

    await captureRouterDirectFailureSnapshots({
      requestId,
      payload,
      error: Object.assign(new Error('HTTP 520: upstream provider error'), {
        code: 'HTTP_520',
        statusCode: 520,
      }),
      entryEndpoint,
      providerKey,
      providerId,
      metadata: { sessionId: 'router-direct-failure-snapshot' },
      requestCaptured: true,
    }, writeProviderSnapshotMock as never);

    expect(writeProviderSnapshotMock).toHaveBeenCalledTimes(2);
    expect(writeProviderSnapshotMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'provider-request',
      requestId,
      data: payload,
      entryEndpoint,
      providerKey,
      providerId,
    }));
    expect(writeProviderSnapshotMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'provider-response',
      requestId,
      entryEndpoint,
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

  it('forces request snapshot first when failure happens before request capture', async () => {
    const { captureRouterDirectFailureSnapshots } = await import('../../../../src/server/runtime/http-server/router-direct-failure-snapshot.js');

    await captureRouterDirectFailureSnapshots({
      requestId: 'req_router_direct_failure_early',
      payload: { model: 'deepseek-v4-flash' },
      error: new Error('HTTP 400: upstream provider error'),
      entryEndpoint: '/v1/chat/completions',
      providerKey: 'XL-deepseek.key1.deepseek-v4-flash',
      providerId: 'XL-deepseek',
      requestCaptured: false,
    }, writeProviderSnapshotMock as never);

    expect(writeProviderSnapshotMock).toHaveBeenCalledTimes(2);
    expect(writeProviderSnapshotMock.mock.calls[0]?.[0]).toMatchObject({
      phase: 'provider-request',
      forceLocalDiskWriteWhenDisabled: true,
    });
    expect(writeProviderSnapshotMock.mock.calls[1]?.[0]).toMatchObject({
      phase: 'provider-response',
      forceLocalDiskWriteWhenDisabled: true,
    });
  });
});
