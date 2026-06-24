import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshot = jest.fn(async () => {});

jest.mock('../../../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot
}), { virtual: true });

jest.mock('../../../../src/providers/auth/oauth-lifecycle.ts', () => ({
  handleUpstreamInvalidOAuthToken: async () => false
}), { virtual: true });

describe('normalizeProviderHttpError snapshot entryPort', () => {
  beforeEach(() => {
    writeProviderSnapshot.mockClear();
  });

  it('forwards entryPort from provider context metadata into provider-error snapshots', async () => {
    const { normalizeProviderHttpError } = await import(
      '../../../../src/providers/core/runtime/provider-http-executor-utils.ts'
    );

    await normalizeProviderHttpError({
      error: new Error('boom'),
      processedRequest: {},
      requestInfo: {
        endpoint: '/responses',
        headers: {},
        targetUrl: 'https://example.invalid/v1/responses',
        body: {},
        wantsSse: true
      },
      context: {
        requestId: 'req-provider-http-entry-port',
        providerKey: 'XLC.key1.glm-5.2',
        providerId: 'XLC',
        metadata: {
          entryPort: 5555
        }
      } as any
    });

    expect(writeProviderSnapshot).toHaveBeenCalledTimes(1);
    expect(writeProviderSnapshot.mock.calls[0]?.[0]).toMatchObject({
      phase: 'provider-error',
      requestId: 'req-provider-http-entry-port',
      entryPort: 5555
    });
  });
});
