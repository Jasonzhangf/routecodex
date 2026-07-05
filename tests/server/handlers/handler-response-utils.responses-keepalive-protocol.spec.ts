import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  createResponsesJsonToSseConverter: jest.fn(async () => ({
    convertResponseToJsonToSse: async () => {
      throw new Error('json_to_sse_not_expected_in_this_test');
    },
  })),
  deriveFinishReasonNative: jest.fn(() => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  importCoreDist: jest.fn(async () => ({
    projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
      emit: true,
      frame: input.frame,
      state: input.state,
    }),
  })),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  projectSseErrorEventPayloadNative: jest.fn(
    (args: { requestId?: string; status?: number; message?: string; code?: string }) => ({
      type: 'error',
      request_id: args.requestId,
      status: args.status ?? 500,
      message: args.message ?? 'sse error',
      code: args.code ?? 'ERR_SSE_ERROR',
    })
  ),
  recordResponsesResponseForRequest: jest.fn(async () => undefined),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  requireCoreDist: jest.fn(() => ({})),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe?: Record<string, unknown>) => probe ?? {}),
}));

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public flushCount = 0;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  flushHeaders(): void {
    // no-op for tests
  }

  flush(): void {
    this.flushCount += 1;
  }
}

describe('responses SSE keepalive protocol', () => {
  it('keeps transport keepalive as SSE comments and does not inject non-Responses events', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = new MockResponse();
    const stream = new PassThrough();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        metadata: { outboundStream: true, stream: true },
        sseStream: stream,
      } as any,
      'req_responses_keepalive_protocol',
      {
        forceSSE: true,
        entryEndpoint: '/v1/responses',
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    stream.write('event: response.completed\n');
    stream.write('data: {"type":"response.completed","response":{"id":"resp_keepalive","object":"response","status":"completed"}}\n\n');
    stream.write('event: response.done\n');
    stream.write('data: {"type":"response.done","response":{"id":"resp_keepalive","object":"response","status":"completed"}}\n\n');
    stream.end();
    await new Promise<void>((resolve) => res.on('finish', () => resolve()));

    const output = chunks.join('');
    expect(output).toContain(': keepalive');
    expect(output).not.toContain('event: ping');
    expect(output).not.toContain('"type":"ping"');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
  });

  it('flushes keepalive and upstream frames without adding protocol events', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = new MockResponse();
    const stream = new PassThrough();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        metadata: { outboundStream: true, stream: true },
        sseStream: stream,
      } as any,
      'req_responses_keepalive_flush',
      {
        forceSSE: true,
        entryEndpoint: '/v1/responses',
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const flushCountAfterKeepalive = res.flushCount;
    stream.write('data: {"type":"response.created","response":{"id":"resp_keepalive_flush","object":"response","status":"in_progress"}}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const flushCountAfterFrame = res.flushCount;
    stream.end();
    await new Promise<void>((resolve) => res.on('finish', () => resolve()));

    const output = chunks.join('');
    expect(output).toContain(': keepalive');
    expect(output).toContain('"type":"response.created"');
    expect(output).not.toContain('event: ping');
    expect(output).not.toContain('"type":"ping"');
    expect(flushCountAfterKeepalive).toBeGreaterThanOrEqual(1);
    expect(flushCountAfterFrame).toBeGreaterThan(flushCountAfterKeepalive);
  });
});
