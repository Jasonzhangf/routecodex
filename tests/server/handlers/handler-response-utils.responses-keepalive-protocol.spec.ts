import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-response-bridge.js', () => ({
  buildResponsesRequestLogContextForHttp: jest.fn(() => ({})),
  prepareResponsesJsonClientDispatchPlanForHttp: jest.fn(async () => ({
    action: 'direct_passthrough',
  })),
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
    const chunk = typeof input.chunk === 'string' ? input.chunk : String(input.chunk ?? '');
    return {
      state: input.state ?? {},
      observedTerminal: chunk.includes('response.completed') || chunk.includes('response.done') || chunk.includes('[DONE]'),
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
