import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
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
});
