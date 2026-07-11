import { Readable, PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', () => ({
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(() => ({ mode: 'json' })),
}));

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({
    resolveRccPathJson: jest.fn(() => JSON.stringify('/tmp/routecodex-test')),
    resolveRccSnapshotsDirJson: jest.fn(() => JSON.stringify('/tmp/routecodex-test/codex-samples')),
    resolveRccUserDirJson: jest.fn(() => JSON.stringify('/tmp/routecodex-test')),
    resolveSessionLogColorKeyJson: jest.fn(() => JSON.stringify('')),
  })),
  projectSseErrorEventPayloadNative: jest.fn((args: unknown) => args),
  projectResponsesSseFrameForClientNative: jest.fn((input: { frame: string; state: unknown }) => ({
    emit: true,
    frame: input.frame,
    state: input.state,
  })),
  updateResponsesSseTransportTerminalStateNative: jest.fn((input: {
    chunk: unknown;
    state: Record<string, unknown> | undefined;
  }) => {
    const chunk = typeof input.chunk === 'string' ? input.chunk : '';
    const observedTerminal =
      chunk.includes('event: response.completed')
      || chunk.includes('event: response.done')
      || chunk.includes('data: [DONE]');
    return {
      state: {
        ...(input.state ?? {}),
        observedTerminal: Boolean((input.state ?? {}).observedTerminal) || observedTerminal,
      },
      observedTerminal,
    };
  }),
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
