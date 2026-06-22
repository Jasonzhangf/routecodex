import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough, Readable } from 'node:stream';
import { runtimeFlags, setRuntimeFlag } from '../../src/runtime/runtime-flags.js';

const writeProviderSnapshot = jest.fn(async () => {});
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);
const shouldCaptureProviderStreamSnapshots = jest.fn(() => true);

jest.unstable_mockModule('../../src/providers/core/utils/snapshot-writer.js', () => ({
  writeProviderSnapshot,
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots
}));

let HttpRequestExecutor: typeof import('../../src/providers/core/runtime/http-request-executor.ts').HttpRequestExecutor;

function createExecutor() {
  const httpClient = {
    postStream: async () => {
      const stream = new PassThrough();
      stream.end('event: done\n\ndata: [DONE]\n\n');
      return stream;
    }
  } as any;

  const deps = {
    wantsUpstreamSse: () => true,
    getEffectiveEndpoint: () => '/v1/messages',
    resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
    buildRequestHeaders: async () => ({ Accept: 'text/event-stream' }),
    finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
    applyStreamModeHeaders: (headers: Record<string, string>) => headers,
    getEffectiveBaseUrl: () => 'https://example.test',
    buildHttpRequestBody: () => ({ prompt: 'ping' }),
    prepareSseRequestBody: () => {},
    getEntryEndpointFromPayload: () => '/v1/responses',
    getClientRequestIdFromContext: () => 'req_client_sse',
    wrapUpstreamSseResponse: async (stream: NodeJS.ReadableStream) => ({ sseStream: stream }),
    normalizeHttpError: async (error: unknown) => error
  } as any;

  return new HttpRequestExecutor(httpClient, deps);
}

function createExecutorWithPreparedSseResponse() {
  const deps = {
    wantsUpstreamSse: () => true,
    getEffectiveEndpoint: () => '/v1/messages',
    resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
    buildRequestHeaders: async () => ({ Accept: 'text/event-stream' }),
    finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
    applyStreamModeHeaders: (headers: Record<string, string>) => headers,
    getEffectiveBaseUrl: () => 'https://example.test',
    buildHttpRequestBody: () => ({ prompt: 'ping' }),
    prepareSseRequestBody: () => {},
    getEntryEndpointFromPayload: () => '/v1/responses',
    getClientRequestIdFromContext: () => 'req_client_sse_prepared',
    wrapUpstreamSseResponse: async (stream: NodeJS.ReadableStream) => ({ sseStream: stream }),
    executePreparedRequest: async () => {
      const stream = new PassThrough();
      stream.end('event: done\n\ndata: [DONE]\n\n');
      return {
        sseStream: stream,
        headers: { 'content-type': 'text/event-stream' }
      };
    },
    normalizeHttpError: async (error: unknown) => error
  } as any;

  return new HttpRequestExecutor({} as any, deps);
}

function createExecutorWithPreparedJsonBodyLabelledSse() {
  const wrapUpstreamSseResponse = jest.fn(async () => {
    throw new Error('MUST_NOT_PARSE_JSON_AS_SSE');
  });
  const deps = {
    wantsUpstreamSse: () => true,
    getEffectiveEndpoint: () => '/v1/chat/completions',
    resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
    buildRequestHeaders: async () => ({ Accept: 'text/event-stream' }),
    finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
    applyStreamModeHeaders: (headers: Record<string, string>) => headers,
    getEffectiveBaseUrl: () => 'https://example.test',
    buildHttpRequestBody: () => ({ model: 'deepseek-v4-pro', stream: true, messages: [] }),
    prepareSseRequestBody: () => {},
    getEntryEndpointFromPayload: () => '/v1/responses',
    getClientRequestIdFromContext: () => 'req_client_json_labelled_sse',
    wrapUpstreamSseResponse,
    executePreparedRequest: async () => ({
      sseStream: Readable.from([
        JSON.stringify({
          id: 'chatcmpl-json-labelled-sse',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'prepared-json-ok' }, finish_reason: 'stop' }
          ]
        })
      ]),
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
      statusText: 'OK'
    }),
    normalizeHttpError: async (error: unknown) => error
  } as any;

  return {
    executor: new HttpRequestExecutor({} as any, deps),
    wrapUpstreamSseResponse
  };
}

function createExecutorWithPreparedSseErrorFrame() {
  const wrapUpstreamSseResponse = jest.fn(async () => {
    throw new Error('MUST_NOT_PARSE_ERROR_SSE_AS_CHAT');
  });
  const resolveBusinessResponseError = jest.fn((response: unknown) => {
    const errorNode = response && typeof response === 'object'
      ? (response as Record<string, any>).error
      : undefined;
    if (errorNode?.type === 'server_error') {
      return Object.assign(new Error('[provider] Upstream provider returned business error: server_error'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'server_error',
        statusCode: 200
      });
    }
    return undefined;
  });
  const deps = {
    wantsUpstreamSse: () => true,
    getEffectiveEndpoint: () => '/v1/chat/completions',
    resolveRequestEndpoint: (_req: any, defaultEndpoint: string) => defaultEndpoint,
    buildRequestHeaders: async () => ({ Accept: 'text/event-stream' }),
    finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
    applyStreamModeHeaders: (headers: Record<string, string>) => headers,
    getEffectiveBaseUrl: () => 'https://example.test',
    buildHttpRequestBody: () => ({ model: 'deepseek-v4-pro', stream: true, messages: [] }),
    prepareSseRequestBody: () => {},
    getEntryEndpointFromPayload: () => '/v1/responses',
    getClientRequestIdFromContext: () => 'req_client_error_sse',
    wrapUpstreamSseResponse,
    executePreparedRequest: async () => ({
      sseStream: Readable.from([
        'data: {"error":{"message":"","type":"server_error"}}\n\n',
        'data: [DONE]\n\n'
      ]),
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
      statusText: 'OK'
    }),
    resolveBusinessResponseError,
    normalizeHttpError: async (error: unknown) => error
  } as any;

  return {
    executor: new HttpRequestExecutor({} as any, deps),
    wrapUpstreamSseResponse,
    resolveBusinessResponseError
  };
}

describe('HttpRequestExecutor SSE snapshot finalization', () => {
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;

  beforeAll(async () => {
    jest.resetModules();
    ({ HttpRequestExecutor } = await import('../../src/providers/core/runtime/http-request-executor.ts'));
  });

  beforeEach(() => {
    setRuntimeFlag('snapshotsEnabled', true);
    writeProviderSnapshot.mockClear();
    attachProviderSseSnapshotStream.mockClear();
    shouldCaptureProviderStreamSnapshots.mockReset();
  });

  afterAll(() => {
    setRuntimeFlag('snapshotsEnabled', originalSnapshotsEnabled);
  });

  it('writes provider-response marker even when raw SSE capture is enabled', async () => {
    shouldCaptureProviderStreamSnapshots.mockReturnValue(true);
    const executor = createExecutor();

    await executor.execute(
      {} as any,
      {
        requestId: 'req_sse_capture_on',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'ali-coding-plan.key1.glm-5',
        providerId: 'ali-coding-plan'
      } as any
    );

    const providerResponseCall = writeProviderSnapshot.mock.calls
      .map((call) => call[0])
      .find((payload) => payload?.phase === 'provider-response');

    expect(providerResponseCall).toBeDefined();
    expect(providerResponseCall).toMatchObject({
      phase: 'provider-response',
      requestId: 'req_sse_capture_on',
      data: expect.objectContaining({
        mode: 'sse',
        captureSse: true,
        transport: 'upstream-stream'
      })
    });
    expect(attachProviderSseSnapshotStream).toHaveBeenCalledTimes(1);
  });

  it('keeps provider-response marker when raw SSE capture is disabled', async () => {
    shouldCaptureProviderStreamSnapshots.mockReturnValue(false);
    const executor = createExecutor();

    await executor.execute(
      {} as any,
      {
        requestId: 'req_sse_capture_off',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'tabglm.key1.glm-5.1',
        providerId: 'tabglm'
      } as any
    );

    const providerResponseCall = writeProviderSnapshot.mock.calls
      .map((call) => call[0])
      .find((payload) => payload?.phase === 'provider-response');

    expect(providerResponseCall).toBeDefined();
    expect(providerResponseCall).toMatchObject({
      phase: 'provider-response',
      requestId: 'req_sse_capture_off',
      data: expect.objectContaining({
        mode: 'sse',
        captureSse: false,
        transport: 'upstream-stream'
      })
    });
    expect(attachProviderSseSnapshotStream).not.toHaveBeenCalled();
  });

  it('writes provider-response marker for executePreparedRequest SSE transports', async () => {
    shouldCaptureProviderStreamSnapshots.mockReturnValue(true);
    const executor = createExecutorWithPreparedSseResponse();

    await executor.execute(
      {} as any,
      {
        requestId: 'req_sse_prepared_transport',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'ali-coding-plan.key1.glm-5',
        providerId: 'ali-coding-plan'
      } as any
    );

    const providerResponseCall = writeProviderSnapshot.mock.calls
      .map((call) => call[0])
      .find((payload) => payload?.phase === 'provider-response');

    expect(providerResponseCall).toBeDefined();
    expect(providerResponseCall).toMatchObject({
      phase: 'provider-response',
      requestId: 'req_sse_prepared_transport',
      data: expect.objectContaining({
        mode: 'sse',
        captureSse: true,
        transport: 'prepared-request-executor'
      })
    });
    expect(attachProviderSseSnapshotStream).toHaveBeenCalledTimes(1);
  });

  it('treats prepared-request JSON body labelled as SSE as JSON response', async () => {
    shouldCaptureProviderStreamSnapshots.mockReturnValue(true);
    const { executor, wrapUpstreamSseResponse } = createExecutorWithPreparedJsonBodyLabelledSse();

    const result = await executor.execute(
      {} as any,
      {
        requestId: 'req_prepared_json_labelled_sse',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'tokenrelay.key1.deepseek-v4-pro',
        providerId: 'tokenrelay'
      } as any
    );

    expect(wrapUpstreamSseResponse).not.toHaveBeenCalled();
    expect((result as any).data.choices[0].message.content).toBe('prepared-json-ok');
  });

  it('raises prepared-request SSE error frame before chat SSE conversion', async () => {
    shouldCaptureProviderStreamSnapshots.mockReturnValue(true);
    const { executor, wrapUpstreamSseResponse, resolveBusinessResponseError } = createExecutorWithPreparedSseErrorFrame();

    await expect(executor.execute(
      {} as any,
      {
        requestId: 'req_prepared_sse_error_frame',
        startTime: Date.now(),
        profile: {} as any,
        providerKey: 'tokenrelay.key1.deepseek-v4-pro',
        providerId: 'tokenrelay'
      } as any
    )).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'server_error',
      statusCode: 200
    });
    expect(resolveBusinessResponseError).toHaveBeenCalledWith(
      { error: { message: '', type: 'server_error' } },
      expect.objectContaining({ providerKey: 'tokenrelay.key1.deepseek-v4-pro' })
    );
    expect(wrapUpstreamSseResponse).not.toHaveBeenCalled();
  });
});
