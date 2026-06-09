import { jest } from '@jest/globals';

const writeProviderSnapshot = jest.fn(async () => {});
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);
const shouldCaptureProviderStreamSnapshots = jest.fn(() => false);

jest.unstable_mockModule('../../src/providers/core/utils/snapshot-writer.js', () => ({
  writeProviderSnapshot,
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots
}));

const { HttpRequestExecutor } = await import('../../src/providers/core/runtime/http-request-executor.ts');

describe('HttpRequestExecutor provider HTTP retry boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    shouldCaptureProviderStreamSnapshots.mockReturnValue(false);
  });

  it('does not retry provider HTTP failures locally', async () => {
    const post = jest.fn()
      .mockRejectedValue(Object.assign(new Error('HTTP 502'), { statusCode: 502 }));

    const httpClient = { post } as any;
    let sequence = 0;
    const deps = {
      wantsUpstreamSse: () => false,
      getEffectiveEndpoint: () => '/api/v0/chat/completion',
      resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
      buildRequestHeaders: async () => ({ Authorization: 'Bearer test' }),
      finalizeRequestHeaders: async (headers: Record<string, string>) => {
        sequence += 1;
        return { ...headers, 'x-ds-pow-response': `pow-${sequence}` };
      },
      applyStreamModeHeaders: (headers: Record<string, string>) => headers,
      getEffectiveBaseUrl: () => 'https://chat.deepseek.com',
      buildHttpRequestBody: () => ({ session_marker: `session-${sequence}` }),
      prepareSseRequestBody: () => {},
      getEntryEndpointFromPayload: () => '/v1/chat/completions',
      getClientRequestIdFromContext: () => 'req_client_retry',
      wrapUpstreamSseResponse: async (stream: NodeJS.ReadableStream) => ({ __sse_responses: stream }),
      normalizeHttpError: async (error: unknown) => error
    } as any;

    const executor = new HttpRequestExecutor(httpClient, deps);
    await expect(executor.execute(
      { data: { prompt: 'hello' } } as any,
      {
        requestId: 'req_retry_pow_refresh',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'deepseek-web.3.deepseek-v4-pro',
        providerId: 'deepseek-web'
      } as any
    )).rejects.toMatchObject({ statusCode: 502 });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[2]?.['x-ds-pow-response']).toBe('pow-1');
    expect(post.mock.calls[0]?.[1]).toEqual({ session_marker: 'session-0' });
  });
});
