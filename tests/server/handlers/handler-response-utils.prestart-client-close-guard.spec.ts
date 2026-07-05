import { Readable, PassThrough } from 'node:stream';
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
    projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
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
  writeSnapshotViaHooks: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

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
}

describe('responses SSE prestart close guard', () => {
  it('does not treat metadata disconnected state as a pre-start socket close', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => resolve());
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        metadata: {
          outboundStream: true,
          stream: true,
          clientConnectionState: { disconnected: true },
        },
        continuationOwner: 'direct',
        sseStream: Readable.from([
          'event: response.completed\n',
          'data: {"type":"response.completed","response":{"id":"resp_prestart_state_only","object":"response","status":"completed"}}\n\n',
          'event: response.done\n',
          'data: {"type":"response.done","response":{"id":"resp_prestart_state_only","object":"response","status":"completed"}}\n\n',
          'data: [DONE]\n\n',
        ]),
      } as any,
      'req-stream-prestart-state-only',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    const output = chunks.join('');
    expect(output).toContain(': keepalive');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output).not.toContain('event: error');
  });
});
