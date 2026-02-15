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

  it.each([
    ['network', { type: 'network' }],
    ['headers timeout', { code: 'UPSTREAM_HEADERS_TIMEOUT' }],
    ['stream timeout', { code: 'UPSTREAM_STREAM_TIMEOUT' }],
    ['http 500', { statusCode: 500 }],
    ['http 404', { statusCode: 404 }],
    ['http 403', { statusCode: 403 }],
    ['http 429', { statusCode: 429 }],
    ['http 400', { statusCode: 400 }]
  ])('switches to next antigravity baseUrl on %s before alias rotation', async (_label, firstError) => {
    const called: string[] = [];
    const httpClient = {
      post: async (url: string) => {
        called.push(url);
        if (called.length === 1) {
          throw firstError;
        }
        return { data: { ok: true }, status: 200 };
      }
    } as any;

    const deps = {
      wantsUpstreamSse: () => false,
      getEffectiveEndpoint: () => '/v1internal:generateContent',
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
      getClientRequestIdFromContext: () => 'client_req_2',
      wrapUpstreamSseResponse: async (stream: any) => ({ __sse_responses: stream }),
      getHttpRetryLimit: () => 1,
      shouldRetryHttpError: () => false,
      delayBeforeHttpRetry: async () => {},
      normalizeHttpError: async (err: any) => err
    } as any;

    const executor = new HttpRequestExecutor(httpClient, deps);
    const response = await executor.execute(
      {} as any,
      {
        requestId: 'req_fallback_1',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'antigravity.jasonqueque.gemini-3-pro-high',
        providerId: 'antigravity'
      } as any
    );

    expect((response as any)?.data?.ok).toBe(true);
    expect(called).toEqual([
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent'
    ]);
  });

  it('does not switch baseUrl when upstream marks antigravity context error', async () => {
    const called: string[] = [];
    const httpClient = {
      post: async (url: string) => {
        called.push(url);
        throw {
          statusCode: 400,
          headers: { 'x-antigravity-context-error': 'signature-mismatch' }
        };
      }
    } as any;

    const deps = {
      wantsUpstreamSse: () => false,
      getEffectiveEndpoint: () => '/v1internal:generateContent',
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
      getClientRequestIdFromContext: () => 'client_req_3',
      wrapUpstreamSseResponse: async (stream: any) => ({ __sse_responses: stream }),
      getHttpRetryLimit: () => 1,
      shouldRetryHttpError: () => false,
      delayBeforeHttpRetry: async () => {},
      normalizeHttpError: async (err: any) => err
    } as any;

    const executor = new HttpRequestExecutor(httpClient, deps);
    await expect(
      executor.execute(
        {} as any,
        {
          requestId: 'req_fallback_blocked',
          startTime: Date.now(),
          profile: {} as any,
          providerKey: 'antigravity.jasonqueque.gemini-3-pro-high',
          providerId: 'antigravity'
        } as any
      )
    ).rejects.toBeTruthy();
    expect(called).toEqual([
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent'
    ]);
  });
});
