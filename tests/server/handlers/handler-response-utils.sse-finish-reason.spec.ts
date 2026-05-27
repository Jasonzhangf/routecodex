import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public jsonBody: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.jsonBody = body;
    this.end(JSON.stringify(body));
    return this;
  }

  flushHeaders(): void {
    // no-op for tests
  }
}

describe('sendPipelineResponse SSE completion logging', () => {
  const mockResponsesJsonToSseConverter = () => ({
    convertResponseToJsonToSse: async () => {
      throw new Error('json_to_sse_not_expected_in_this_test');
    }
  });
  const originalVerbose = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const originalStageLog = process.env.ROUTECODEX_STAGE_LOG;
  const originalStageVerbose = process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
  const originalStageTiming = process.env.ROUTECODEX_STAGE_TIMING;
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    process.env.ROUTECODEX_STAGE_LOG = '1';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';
    delete process.env.ROUTECODEX_STAGE_TIMING;
    logSpy.mockClear();
    jest.resetModules();
  });

  afterAll(() => {
    if (originalVerbose === undefined) {
      delete process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_HTTP_LOG_VERBOSE = originalVerbose;
    }
    if (originalStageLog === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG;
    } else {
      process.env.ROUTECODEX_STAGE_LOG = originalStageLog;
    }
    if (originalStageVerbose === undefined) {
      delete process.env.ROUTECODEX_STAGE_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_STAGE_LOG_VERBOSE = originalStageVerbose;
    }
    if (originalStageTiming === undefined) {
      delete process.env.ROUTECODEX_STAGE_TIMING;
    } else {
      process.env.ROUTECODEX_STAGE_TIMING = originalStageTiming;
    }
    logSpy.mockRestore();
  });

  it('logs finish_reason after streamed responses complete', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1010)
      .mockReturnValueOnce(1075)
      .mockReturnValueOnce(1080);

    const res = new MockResponse();
    const stream = Readable.from([
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"status":"requires_action","required_action":{"submit_tool_outputs":{"tool_calls":[]}}}}\n\n',
      'data: [DONE]\n\n'
    ]);

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_finish_reason: 'tool_calls'
        }
      } as any,
      'req-stream-finish',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('t+75ms'));
    expect(logSpy.mock.calls.filter((call) => String(call?.[0] ?? '').includes('[response.sse.stream][req-stream-finish] end'))).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[response][req-stream-finish] completed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b[97mfinish_reason=tool_calls\x1b[0m'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[response][req-stream-finish] completed t+0ms'));
  });

  it('logs client_close diagnostics when SSE closes before terminal event', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const stream = new PassThrough();
    const clearRequest = jest.fn();
    (globalThis as Record<string, unknown>).__rccResponsesConversationStore = { clearRequest };

    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream
        }
      } as any,
      'req-stream-client-close',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.output_text.delta\n');
    stream.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    res.destroy();

    await closed;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[response.sse][req-stream-client-close] client_close'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"closeBeforeStreamEnd":true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sawTerminalEvent":false'));
    expect(clearRequest).toHaveBeenCalledWith('req-stream-client-close');
    delete (globalThis as Record<string, unknown>).__rccResponsesConversationStore;
  });

  it('does not enforce stopless contract inside raw SSE handler path', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    const stream = Readable.from([
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"继续处理，但没有完成标记"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
      'data: [DONE]\n\n'
    ]);

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_finish_reason: 'stop'
        },
        usageLogInfo: {
          stoplessMode: 'on',
          stoplessArmed: true
        }
      } as any,
      'req-stopless-sse-missing-finalization',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    const output = chunks.join('');
    expect(output).not.toContain('event: error');
    expect(output).not.toContain('STOPLESS_FINALIZATION_MISSING');
  });

  it('does not treat streamed wrapper finish_reason as stopless truth source in handler path', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    const stream = Readable.from([
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"阶段性输出"}\n\n',
      'data: [DONE]\n\n'
    ]);

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_finish_reason: 'stop'
        },
        usageLogInfo: {
          stoplessMode: 'on',
          stoplessArmed: true
        }
      } as any,
      'req-stopless-sse-wrapper-stop',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    const output = chunks.join('');
    expect(output).not.toContain('event: error');
    expect(output).not.toContain('STOPLESS_FINALIZATION_MISSING');
  });

  it('passes structured non-stream errors through SSE without rewriting them to HTTP_502', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 503,
        body: {
          error: {
            message: 'Server is still starting',
            code: 'server_starting'
          }
        }
      } as any,
      'req-startup-structured-error',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: error');
    expect(output).toContain('"status":503');
    expect(output).toContain('"code":"server_starting"');
    expect(output).toContain('"request_id":"req-startup-structured-error"');
    expect(output).not.toContain('sse_bridge_error');
    expect(output).not.toContain('"status":502');
  });

  it('does not close SSE before upstream emits trailing tail after response.completed', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    const stream = new PassThrough();

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream
        }
      } as any,
      'req-stream-tail-after-completed',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.completed\n');
    stream.write(
      'data: {"type":"response.completed","response":{"id":"resp_tail","object":"response","status":"completed"}}\n\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.write('data: [DONE]\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('RED: does not silently swallow trailing frames after tool_calls terminal event before upstream end', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    const responseErrors: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    res.on('error', (error) => responseErrors.push(String(error instanceof Error ? error.message : error)));
    const stream = new PassThrough();

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_stream_finish_reason: 'tool_calls'
        }
      } as any,
      'req-stream-tool-calls-tail',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.completed\n');
    stream.write(
      'data: {"type":"response.completed","response":{"id":"resp_tool_tail","object":"response","status":"requires_action"}}\n\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    stream.write(': trailing-tail-after-terminal\n\n');
    stream.write('data: [DONE]\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain(': trailing-tail-after-terminal');
    expect(output).toContain('data: [DONE]');
    expect(responseErrors).toEqual([]);
  });

  it('RED: synthesizes response.completed when stream closes without terminal but contractProbe already carries completed response fact', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    const stream = new PassThrough();

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_stream_finish_reason: 'stop',
          __routecodex_stream_contract_probe_body: {
            id: 'resp_probe_completed_1',
            object: 'response',
            status: 'completed',
            output: [
              {
                id: 'msg_probe_completed_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'ok'
                  }
                ]
              }
            ],
            output_text: 'ok'
          }
        }
      } as any,
      'req-stream-probe-completed-no-terminal',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.created\n');
    stream.write(
      'data: {"type":"response.created","response":{"id":"resp_probe_completed_1","object":"response","status":"in_progress"}}\n\n'
    );
    stream.write('event: response.output_text.delta\n');
    stream.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"status":"completed"');
    expect(output).toContain('"output_text":"ok"');
    expect(output).toContain('data: [DONE]');
    expect(output).not.toContain('upstream_stream_incomplete');
    expect(output).not.toContain('event: error');
  });
});
