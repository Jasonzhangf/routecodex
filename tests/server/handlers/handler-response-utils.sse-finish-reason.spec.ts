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

  it('does not attach stream contract probe for empty response.created placeholder', async () => {
    const { buildServerToolSseWrapperBody, STREAM_CONTRACT_PROBE_BODY_KEY } = await import(
      '../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js'
    );
    const body = buildServerToolSseWrapperBody({
      sseResponses: Readable.from([]),
      convertedBody: {
        id: '066acd209c6b56063dc1679d535ece5c',
        object: 'response',
        status: 'completed',
        output: []
      }
    });

    expect(body).toHaveProperty('__sse_responses');
    expect(body).not.toHaveProperty(STREAM_CONTRACT_PROBE_BODY_KEY);
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.required_action') || text.includes('"type":"response.required_action"')) {
          next.__seen_response_required_action = true;
        }
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
    const clearResponsesConversationByRequestId = jest.fn(async () => undefined);
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.required_action') || text.includes('"type":"response.required_action"')) {
          next.__seen_response_required_action = true;
        }
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
    expect(clearResponsesConversationByRequestId).toHaveBeenCalledWith('req-stream-client-close');
  });

  it('persists required_action continuation instead of clearing store when client closes before response.done', async () => {
    const captureResponsesRequestContextForRequest = jest.fn(async () => undefined);
    const clearResponsesConversationByRequestId = jest.fn(async () => undefined);
    const finalizeResponsesConversationRequestRetention = jest.fn(async () => undefined);
    const recordResponsesResponseForRequest = jest.fn(async () => undefined);
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest,
      clearResponsesConversationByRequestId,
      finalizeResponsesConversationRequestRetention,
      recordResponsesResponseForRequest,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: (body: unknown) => {
        return Boolean(
          body
          && typeof body === 'object'
          && !Array.isArray(body)
          && (body as Record<string, unknown>).required_action
        );
      },
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) return next;
        const parsed = JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
        const response = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
          ? parsed.response as Record<string, unknown>
          : undefined;
        if (response) Object.assign(next, response);
        if (parsed.required_action) next.required_action = parsed.required_action;
        if (parsed.type === 'response.required_action') next.__seen_response_required_action = true;
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
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
    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 25));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __routecodex_finish_reason: 'tool_calls'
        },
        usageLogInfo: {
          providerKey: 'asxs.crsa.gpt-5.5',
          timingRequestIds: ['req-direct-required-action-close'],
          finishReason: 'tool_calls',
          sessionId: 'sess-direct-relay-close',
          conversationId: 'conv-direct-relay-close'
        }
      } as any,
      'req-direct-required-action-close',
      {
        forceSSE: true,
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'run tool' }] }],
            tools: [{ type: 'function', name: 'exec_command' }]
          },
          context: {
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'run tool' }] }],
            toolsRaw: [{ type: 'function', name: 'exec_command' }]
          },
          sessionId: 'sess-direct-relay-close',
          conversationId: 'conv-direct-relay-close',
          matchedPort: 5555,
          routingPolicyGroup: 'gateway_priority_5555'
        }
      }
    );

    stream.write('event: response.required_action\n');
    stream.write(
      'data: {"type":"response.required_action","response":{"id":"resp_direct_required_action_close","object":"response","status":"requires_action"},"required_action":{"submit_tool_outputs":{"tool_calls":[{"id":"call_direct_close","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}}\n\n'
    );
    res.destroy();

    await closed;

    expect(recordResponsesResponseForRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'resp_direct_required_action_close',
      providerKey: 'asxs.crsa.gpt-5.5',
      sessionId: 'sess-direct-relay-close',
      conversationId: 'conv-direct-relay-close',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    }));
    expect(captureResponsesRequestContextForRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'resp_direct_required_action_close',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    }));
    expect(finalizeResponsesConversationRequestRetention).toHaveBeenCalledWith(
      'resp_direct_required_action_close',
      { keepForSubmitToolOutputs: true }
    );
    expect(clearResponsesConversationByRequestId).not.toHaveBeenCalledWith('resp_direct_required_action_close');
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          ...(probe.__seen_response_done ? [] : [
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
          ]),
          ...(probe.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
        ];
      },
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          ...(probe.__seen_response_done ? [] : [
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
          ]),
          ...(probe.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
        ];
      },
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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

  it('RED: data DONE alone is not a Responses terminal event and completed probe is still emitted', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            ...(probe.__seen_response_done ? [] : [
              `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
            ]),
            ...(probe.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          ...(probe.__seen_response_done ? [] : [
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
          ]),
          ...(probe.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
        ];
      },
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
          __routecodex_stream_contract_probe_body: {
            id: 'resp_done_only_probe_1',
            object: 'response',
            status: 'completed',
            output: [
              {
                id: 'msg_done_only_probe_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'ok' }]
              }
            ],
            output_text: 'ok'
          }
        }
      } as any,
      'req-stream-done-only-with-probe',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.output_text.delta\n');
    stream.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    stream.write('data: [DONE]\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).not.toContain('upstream_stream_incomplete');
    expect(output).not.toContain('event: error');
  });

  it('RED: appends DONE when upstream emits response.completed and response.done without DONE sentinel', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
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
      'req-stream-terminal-without-done',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.completed\n');
    stream.write('data: {"type":"response.completed","response":{"id":"resp_no_done","object":"response","status":"completed"}}\n\n');
    stream.write('event: response.done\n');
    stream.write('data: {"type":"response.done","response":{"id":"resp_no_done","object":"response","status":"completed"}}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).not.toContain('event: error');
  });

  it('RED: treats event: message with bare data.type=response.completed as terminal to avoid false upstream_stream_incomplete', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: (probe: any) => {
        if (!probe || typeof probe !== 'object') return [];
        const response = {
          id: probe.id ?? 'resp_test_probe',
          object: 'response',
          status: probe.required_action ? 'requires_action' : (probe.status ?? 'completed'),
          ...(probe.output ? { output: probe.output } : {}),
          ...(probe.output_text ? { output_text: probe.output_text } : {})
        };
        if (probe.required_action) {
          return [
            `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
            `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
            'data: [DONE]\n\n'
          ];
        }
        return [
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
          'data: [DONE]\n\n'
        ];
      },
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
      'req-stream-message-event-terminal',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: message\n');
    stream.write('data: {"type":"response.completed"}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: message');
    expect(output).toContain('"type":"response.completed"');
    expect(output).not.toContain('upstream_stream_incomplete');
    expect(output).not.toContain('event: error');
  });

  it('does not duplicate stream frames in client-response snapshots', async () => {
    const snapshots: Array<{ phase?: string; data?: Record<string, unknown> }> = [];
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => ({}),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => true,
      writeServerSnapshot: async (snapshot: { phase?: string; data?: Record<string, unknown> }) => {
        snapshots.push(snapshot);
      }
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
      'req-stream-snapshot-no-duplicate',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.output_text.delta\n');
    stream.write('data: {"type":"response.output_text.delta","sequence_number":7,"delta":"once"}\n\n');
    stream.write('event: response.completed\n');
    stream.write('data: {"type":"response.completed","sequence_number":8,"response":{"id":"resp_once","object":"response","status":"completed"}}\n\n');
    stream.write('event: response.done\n');
    stream.write('data: {"type":"response.done","sequence_number":9,"response":{"id":"resp_once","object":"response","status":"completed"}}\n\n');
    stream.write('data: [DONE]\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output.match(/sequence_number":7/g)).toHaveLength(1);
    const clientSnapshot = snapshots.find((snapshot) => snapshot.phase === 'client-response');
    expect(clientSnapshot).toBeDefined();
    const bodyText = String(clientSnapshot?.data?.bodyText ?? '');
    expect(bodyText.match(/sequence_number":7/g)).toHaveLength(1);
  });

  it('does not repair required_action streams with response.completed', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.required_action') || text.includes('"type":"response.required_action"')) {
          next.__seen_response_required_action = true;
        }
        if (text.includes('event: response.done') || text.includes('"type":"response.done"')) {
          next.__seen_response_done = true;
        }
        if (text.includes('data: [DONE]')) {
          next.__seen_done_chunk = true;
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: (probe: Record<string, unknown> | undefined) => [
        ...(probe?.__seen_response_done ? [] : [
          'event: response.done\n' +
            'data: {"type":"response.done","response":{"id":"resp_tool","object":"response","status":"requires_action"}}\n\n'
        ]),
        ...(probe?.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
      ],
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
      res.on('finish', () => setTimeout(resolve, 180));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: stream,
          __stream_contract_probe_body: {
            id: 'resp_tool',
            object: 'response',
            status: 'requires_action',
            required_action: { submit_tool_outputs: { tool_calls: [] } }
          }
        }
      } as any,
      'req-required-action-no-completed-repair',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.required_action\n');
    stream.write('data: {"type":"response.required_action","sequence_number":105,"response":{"id":"resp_tool","object":"response","status":"requires_action"},"required_action":{"submit_tool_outputs":{"tool_calls":[]}}}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output.match(/event: response.required_action/g)).toHaveLength(1);
    expect(output).not.toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});
