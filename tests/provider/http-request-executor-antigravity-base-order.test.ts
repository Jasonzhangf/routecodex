import { PassThrough } from 'node:stream';
import { HttpRequestExecutor } from '../../src/providers/core/runtime/http-request-executor.js';
import { setRuntimeFlag } from '../../src/runtime/runtime-flags.js';

describe('HttpRequestExecutor antigravity base order', () => {
  beforeAll(() => {
    setRuntimeFlag('snapshotsEnabled', false);
  });

  it('prefers sandbox/daily candidates before configured primary base', async () => {
    const called: string[] = [];
    const httpClient = {
      postStream: async (url: string) => {
        called.push(url);
        const s = new PassThrough();
        s.end();
        return s;
      }
    } as any;

    const deps = {
      wantsUpstreamSse: () => true,
      getEffectiveEndpoint: () => '/v1internal:streamGenerateContent?alt=sse',
      resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
      buildRequestHeaders: async () => ({}),
      finalizeRequestHeaders: async (h: any) => h,
      applyStreamModeHeaders: (h: any) => h,
      getEffectiveBaseUrl: () => 'https://cloudcode-pa.googleapis.com',
      getBaseUrlCandidates: () => [
        'https://daily-cloudcode-pa.sandbox.googleapis.com',
        'https://daily-cloudcode-pa.googleapis.com',
        'https://cloudcode-pa.googleapis.com'
      ],
      buildHttpRequestBody: () => ({}),
      prepareSseRequestBody: () => {},
      getEntryEndpointFromPayload: () => '/v1/responses',
      getClientRequestIdFromContext: () => 'client_req_1',
      wrapUpstreamSseResponse: async (stream: any) => ({ __sse_responses: stream }),
      getHttpRetryLimit: () => 1,
      shouldRetryHttpError: () => false,
      delayBeforeHttpRetry: async () => {},
      normalizeHttpError: async (err: any) => err
    } as any;

    const executor = new HttpRequestExecutor(httpClient, deps);

    await executor.execute(
      {} as any,
      {
        requestId: 'req_1',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'antigravity.jasonqueque.claude-sonnet-4-5',
        providerId: 'antigravity'
      } as any
    );

    expect(called[0]).toBe(
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse'
    );
  });
});

