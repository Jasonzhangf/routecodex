import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshot = jest.fn(async () => {});
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);

jest.mock('../../../../src/providers/core/utils/snapshot-writer.ts', () => ({
  writeProviderSnapshot,
  attachProviderSseSnapshotStream
}), { virtual: true });

jest.mock('../../../../src/providers/auth/oauth-lifecycle.ts', () => ({
  handleUpstreamInvalidOAuthToken: async () => false
}), { virtual: true });

describe('OAuthRecoveryHandler snapshot entryPort', () => {
  beforeEach(() => {
    writeProviderSnapshot.mockClear();
    attachProviderSseSnapshotStream.mockClear();
  });

  it('forwards entryPort on non-stream retry provider-response snapshots', async () => {
    const { OAuthRecoveryHandler } = await import(
      '../../../../src/providers/core/runtime/transport/oauth-recovery-handler.ts'
    );

    const handler = new OAuthRecoveryHandler({
      authProvider: { refreshCredentials: async () => {} } as any,
      providerType: 'deepseek',
      config: {
        id: 'deepseek-refresh-json',
        type: 'openai-http-provider',
        config: {
          auth: { type: 'oauth', rawType: 'deepseek-account' }
        }
      } as any,
      httpClient: {
        postStreamOrResponse: async () => ({
          kind: 'response',
          responseKind: 'json',
          response: {
            data: { id: 'resp_json' },
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        })
      } as any
    });

    await (handler as any).executeRecoveredSseReplay({
      requestInfo: {
        targetUrl: 'https://example.invalid/v1/chat/completions',
        body: { model: 'deepseek-v4-pro', stream: false, messages: [] },
        headers: { Authorization: 'Bearer old' },
        wantsSse: false,
        entryEndpoint: '/v1/chat/completions',
        clientRequestId: 'client_oauth_retry'
      } as any,
      finalRetryHeaders: { Authorization: 'Bearer refreshed' },
      captureSse: false,
      context: {
        requestId: 'req-oauth-retry-entry-port',
        providerKey: 'deepseek.key1.deepseek-v4-pro',
        providerId: 'deepseek',
        metadata: { matchedPort: 5520 }
      } as any,
      wrapUpstreamSseResponse: async () => ({}),
      extra: { retry: true },
      snapshotStage: 'http_retry'
    });

    expect(writeProviderSnapshot).toHaveBeenCalled();
    expect(writeProviderSnapshot.mock.calls[0]?.[0]).toMatchObject({
      phase: 'provider-response',
      requestId: 'req-oauth-retry-entry-port',
      entryPort: 5520
    });
  });
});
