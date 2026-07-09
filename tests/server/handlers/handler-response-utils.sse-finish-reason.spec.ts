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

function createMockCoreDistProjectionModule() {
  return {
    projectResponsesSseFrameForClientWithNative: (input: { frame: string; eventName?: string; data?: Record<string, unknown>; state: unknown }) => {
      const requiredAction = input.data?.required_action as Record<string, unknown> | undefined;
      const submit = requiredAction?.submit_tool_outputs as Record<string, unknown> | undefined;
      const calls = Array.isArray(submit?.tool_calls) ? submit.tool_calls as Record<string, unknown>[] : [];
      if (input.eventName === 'response.required_action' && calls.length > 0) {
        const frames = calls.map((call, index) => {
          const fn = call.function as Record<string, unknown> | undefined;
          const callId = String(call.id ?? call.call_id ?? `call_${index + 1}`);
          const name = String(fn?.name ?? call.name ?? 'function');
          const args = String(fn?.arguments ?? call.arguments ?? '{}');
          const itemId = `fc_${callId}`;
          return [
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: index, item: { id: itemId, type: 'function_call', call_id: callId, name, arguments: '', status: 'in_progress' } })}\n\n`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: index, item_id: itemId, call_id: callId, delta: args })}\n\n`,
            `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', output_index: index, item_id: itemId, call_id: callId, name, arguments: args })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item: { id: itemId, type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' } })}\n\n`,
          ].join('');
        }).join('');
        return { emit: true, frame: frames, state: input.state };
      }
      return {
        emit: true,
        frame: input.frame,
        state: input.state,
      };
    },
    projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
  };
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
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    process.env.ROUTECODEX_STAGE_LOG = '1';
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE = '1';
    delete process.env.ROUTECODEX_STAGE_TIMING;
    logSpy.mockClear();
    warnSpy.mockClear();
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
    warnSpy.mockRestore();
  });

  it('derives usage finish_reason from responses SSE terminal frames instead of logging unknown', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('"type":"response.output_item.done"')) {
          next.id = 'resp_usage_finish_reason';
          next.status = 'completed';
          next.output = [{
            id: 'msg_usage_finish_reason',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done' }]
          }];
        }
        return next;
      },
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const stream = Readable.from([
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_usage_finish_reason","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_usage_finish_reason","object":"response","status":"completed","output":[{"id":"msg_usage_finish_reason","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    ]);

    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 50));
    });
    const usageLogInfo = {
      finishReason: 'stop',
      requestStartedAtMs: Date.now(),
      routeName: 'router-direct:coding/-',
      model: 'gpt-5.4',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cache_read_input_tokens: 0,
      }
    };

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: stream,
        usageLogInfo,
      } as any,
      'req-stream-usage-finish-reason',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const logOutput = logSpy.mock.calls.map((call) => String(call?.[0] ?? '')).join('\n');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('req-stream-usage-finish-reason'));
    expect(logOutput).not.toContain('req-stream-usage-finish-reason completed');
    expect(logOutput).not.toContain('finish_reason=\u001b[97munknown\u001b[0m');
    expect(usageLogInfo.finishReason).toBe('stop');
  });

  it('destroys the original upstream SSE stream when client closes before terminal event', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    res.on('error', () => {});
    const upstream = new PassThrough();
    let destroyReason: unknown;
    const originalDestroy = upstream.destroy.bind(upstream);
    const destroySpy = jest.spyOn(upstream, 'destroy').mockImplementation((error?: Error) => {
      destroyReason = error;
      return originalDestroy(error);
    });

    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: upstream
      } as any,
      'req-stream-client-close-upstream-abort',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    upstream.write('event: response.output_text.delta\n');
    upstream.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    res.destroy();

    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(destroySpy).toHaveBeenCalled();
    expect((destroyReason as { code?: unknown } | undefined)?.code).toBe('CLIENT_DISCONNECTED');
    expect((destroyReason as Error | undefined)?.message).toBe('CLIENT_RESPONSE_CLOSED');
  });

  it('does not report client close after Responses terminal event as before-terminal failure', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    const writeServerSnapshot = jest.fn(async () => undefined);
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => true,
      writeServerSnapshot
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    res.on('error', () => {});
    const upstream = new PassThrough();
    let output = '';
    res.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('event: response.completed')) {
        res.destroy();
      }
    });

    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: upstream
      } as any,
      'req-terminal-client-close-not-before-terminal',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    upstream.write('event: response.completed\n');
    upstream.write(
      'data: {"type":"response.completed","response":{"id":"resp_terminal_close","object":"response","status":"completed","output":[]}}\n\n'
    );

    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const warnOutput = warnSpy.mock.calls.map((call) => String(call?.[0] ?? '')).join('\n');
    expect(output).toContain('event: response.completed');
    expect(warnOutput).not.toContain('client_close_before_terminal');
    expect(writeServerSnapshot).not.toHaveBeenCalledWith(expect.objectContaining({
      phase: 'client-response.error',
      data: expect.objectContaining({
        reason: 'client_close_before_terminal',
      }),
    }));
  });

  it('does not prestart-close a responses SSE stream unless the client is explicitly marked disconnected', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    const upstream = Readable.from([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_prestart_guard","object":"response","status":"in_progress","output":[]}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_prestart_guard","object":"response","status":"completed","output":[]}}\n\n',
      'event: response.done\n',
      'data: {"type":"response.done","response":{"id":"resp_prestart_guard","object":"response","status":"completed","output":[]}}\n\n',
    ]);

    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => setTimeout(resolve, 0));
    });

    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: upstream,
        metadata: {
          clientConnectionState: {
            disconnected: false
          }
        }
      } as any,
      'req-prestart-client-close-guard',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;

    const output = chunks.join('');
    const warnOutput = warnSpy.mock.calls.map((call) => String(call?.[0] ?? '')).join('\n');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output).not.toContain('stream closed before response.completed');
    expect(warnOutput).not.toContain('prestart_client_close');
  });

  it('destroys upstream immediately on client close even when response projection is still pending', async () => {
    const previousProjectionTimeout = process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
    process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = '5000';
    let releaseProjection: (() => void) | undefined;
    const clearResponsesConversationByRequestId = jest.fn(async () => undefined);
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => {
        await new Promise<void>((resolve) => {
          releaseProjection = resolve;
        });
        return {
          projectResponsesSseFrameForClientWithNative: (input: { frame: string; state: unknown }) => ({
            emit: true,
            frame: input.frame,
            state: input.state,
          }),
        };
      },
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    res.on('error', () => {});
    const upstream = new PassThrough();
    let destroyReason: unknown;
    const originalDestroy = upstream.destroy.bind(upstream);
    const destroySpy = jest.spyOn(upstream, 'destroy').mockImplementation((error?: Error) => {
      destroyReason = error;
      return originalDestroy(error);
    });

    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 0));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: upstream
      } as any,
      'req-stream-client-close-projection-pending',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    try {
      upstream.write('event: response.output_text.delta\n');
      upstream.write(
        'data: {"type":"response.output_text.delta","delta":"hi","required_action":{"submit_tool_outputs":{"tool_calls":[{"id":"call_projection_pending","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}}\n\n'
      );
      res.destroy();

      await closed;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      expect(destroySpy).toHaveBeenCalled();
      expect((destroyReason as { code?: unknown } | undefined)?.code).toBe('CLIENT_DISCONNECTED');
      releaseProjection?.();
    } finally {
      if (previousProjectionTimeout === undefined) {
        delete process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS;
      } else {
        process.env.ROUTECODEX_HTTP_SSE_PROJECTION_TIMEOUT_MS = previousProjectionTimeout;
      }
    }
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
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    const res = new MockResponse();
    res.on('error', () => {});
    const stream = new PassThrough();
    const closed = new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(resolve, 25));
    });

    sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: stream,
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    res.destroy();

    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(res.destroyed).toBe(true);
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
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream,
        usageLogInfo: {
          stoplessMode: 'on',
          stoplessArmed: true
        }
      } as any,
      'req-stopless-sse-missing-finalization',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    await finished;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const output = chunks.join('');
    expect(output).not.toContain('event: error');
    expect(output).not.toContain('upstream_stream_incomplete');
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
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream,
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

  it('fails fast with missing-stream SSE bridge error for forced SSE non-stream body', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
    expect(output).toContain('"status":502');
    expect(output).toContain('"code":"sse_bridge_error"');
    expect(output).toContain('"request_id":"req-startup-structured-error"');
  });

  it('does not close SSE before upstream emits trailing tail after response.completed', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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

  it('adds DONE sentinel when relay Responses SSE ends after completed without upstream DONE', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
      } as any,
      'req-stream-completed-missing-done',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.completed\n');
    stream.write(
      'data: {"type":"response.completed","response":{"id":"resp_missing_done","object":"response","status":"completed"}}\n\n'
    );
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
    expect(output.indexOf('event: response.completed')).toBeLessThan(output.indexOf('data: [DONE]'));
  });

  it('RED: does not silently swallow trailing frames after tool_calls terminal event before upstream end', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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

  it('does not synthesize response.completed when stream closes without standard terminal event', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.output_text.delta');
    expect(output).not.toContain('event: response.completed');
    expect(output).not.toContain('event: error');
  });

  it('passes DONE-only SSE frames through without synthesizing completion', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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
    expect(output).not.toContain('event: response.completed');
    expect(output).not.toContain('event: response.done');
    expect(output).toContain('data: [DONE]');
  });

  it('does not synthesize DONE when upstream emits response.completed and response.done', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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
    expect(output).toContain('data: [DONE]');
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
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
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
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
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

  it('RED: detects response.completed terminal marker across SSE chunk boundaries', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
      } as any,
      'req-stream-terminal-split-across-chunks',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.com');
    stream.write('pleted\n');
    stream.write('data: {"type":"response.com');
    stream.write('pleted","response":{"id":"resp_split_done","object":"response","status":"completed"}}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).not.toContain('upstream_stream_incomplete');
    expect(output).not.toContain('event: error');
  });

  it('does not record client-close-before-terminal after spaced data.type=response.completed was written', async () => {
    const previousStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'client-response,client-response.error';
    const snapshots: Array<{ phase?: string; data?: Record<string, unknown> }> = [];
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => true,
      writeServerSnapshot: async (snapshot: { phase?: string; data?: Record<string, unknown> }) => {
        snapshots.push(snapshot);
      }
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    try {
      const res = new MockResponse();
      res.on('error', () => {});
      const chunks: string[] = [];
      res.on('data', (chunk) => chunks.push(String(chunk)));
      const stream = new PassThrough();
      stream.on('error', () => {});
      let destroyReason: unknown;
      const destroySpy = jest.spyOn(stream, 'destroy').mockImplementation((error?: Error) => {
        destroyReason = error;
        return PassThrough.prototype.destroy.call(stream, error);
      });

      const closed = new Promise<void>((resolve) => {
        res.on('close', () => setTimeout(resolve, 0));
      });

      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: stream
        } as any,
        'req-stream-spaced-terminal-client-close',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );

      stream.write('event: message\n');
      stream.write('data: {"type": "response.completed", "response": {"id": "resp_spaced_done", "status": "completed"}}\n\n');
      res.destroy();

      await closed;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const output = chunks.join('');
      expect(output).toContain('"type": "response.completed"');
      expect(snapshots.some((snapshot) => snapshot.phase === 'client-response.error')).toBe(false);
      expect(destroySpy).toHaveBeenCalled();
      expect(destroyReason).toBeInstanceOf(Error);
    } finally {
      if (previousStages === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = previousStages;
      }
    }
  });

  it('does not miss response.completed when terminal frame body is larger than scan buffer', async () => {
    const previousStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'client-response,client-response.error';
    const snapshots: Array<{ phase?: string; data?: Record<string, unknown> }> = [];
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => true,
      writeServerSnapshot: async (snapshot: { phase?: string; data?: Record<string, unknown> }) => {
        snapshots.push(snapshot);
      }
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    try {
      const res = new MockResponse();
      res.on('error', () => {});
      const chunks: string[] = [];
      res.on('data', (chunk) => chunks.push(String(chunk)));
      const stream = new PassThrough();
      stream.on('error', () => {});
      let destroyReason: unknown;
      const destroySpy = jest.spyOn(stream, 'destroy').mockImplementation((error?: Error) => {
        destroyReason = error;
        return PassThrough.prototype.destroy.call(stream, error);
      });

      const closed = new Promise<void>((resolve) => {
        res.on('close', () => setTimeout(resolve, 0));
      });

      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: stream
        } as any,
        'req-stream-large-terminal-client-close',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );

      const largeCompletedFrame = `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_large_done',
          object: 'response',
          status: 'completed',
          output: [{
            id: 'msg_large_done',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'x'.repeat(4096) }]
          }]
        }
      })}\n\n`;
      stream.write(largeCompletedFrame);
      res.destroy();

      await closed;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const output = chunks.join('');
      expect(output).toContain('event: response.completed');
      expect(output).toContain('"type":"response.completed"');
      expect(snapshots.some((snapshot) => snapshot.phase === 'client-response.error')).toBe(false);
      expect(destroySpy).toHaveBeenCalled();
      expect(destroyReason).toBeInstanceOf(Error);
    } finally {
      if (previousStages === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = previousStages;
      }
    }
  });

  it('does not duplicate stream frames in client-response snapshots', async () => {
    const previousStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'client-response';
    const snapshots: Array<{ phase?: string; data?: Record<string, unknown> }> = [];
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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

    try {
      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: stream
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
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      const output = chunks.join('');
      expect(output.match(/sequence_number":7/g)).toHaveLength(1);
      const clientSnapshot = snapshots.find((snapshot) => snapshot.phase === 'client-response');
      if (clientSnapshot) {
        const bodyText = String(clientSnapshot.data?.bodyText ?? '');
        expect(bodyText.match(/sequence_number":7/g)).toHaveLength(1);
      }
    } finally {
      if (previousStages === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = previousStages;
      }
    }
  });

  it('does not auto-close early for function_call response.output_item.done before real terminal events', async () => {
    const previousTerminalTimeout = process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
    process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = '50';
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
      buildResponsesTerminalSseFramesFromProbeNative: () => [],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
      requireCoreDist: () => ({})
    }));
    jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
      isSnapshotsEnabled: () => false,
      writeServerSnapshot: async () => undefined
    }));
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');

    try {
      const res = new MockResponse();
      const chunks: string[] = [];
      res.on('data', (chunk) => chunks.push(String(chunk)));
      const stream = new PassThrough();
      stream.on('error', () => {});
      let finished = false;
      res.on('finish', () => {
        finished = true;
      });

      sendPipelineResponse(
        res as any,
        {
          status: 200,
          sseStream: stream
        } as any,
        'req-function-call-not-terminal',
        { forceSSE: true, entryEndpoint: '/v1/responses' }
      );

      stream.write('event: response.output_item.done\n');
      stream.write('data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_not_terminal","type":"function_call","call_id":"call_not_terminal","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}","status":"completed"}}\n\n');

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(finished).toBe(false);
      expect(chunks.join('')).not.toContain('event: response.completed');
      expect(chunks.join('')).not.toContain('event: response.done');

      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stream did not complete\n${chunks.join('')}`)), 1_500);
        res.on('finish', () => {
          clearTimeout(timer);
          setTimeout(resolve, 0);
        });
      });

      stream.write('event: response.completed\n');
      stream.write('data: {"type":"response.completed","response":{"id":"resp_function_call_not_terminal","object":"response","status":"requires_action"}}\n\n');
      stream.write('event: response.done\n');
      stream.write('data: {"type":"response.done","response":{"id":"resp_function_call_not_terminal","object":"response","status":"requires_action"}}\n\n');
      stream.end();

      await completed;
      const output = chunks.join('');
      expect(output).toContain('event: response.output_item.done');
      expect(output).toContain('event: response.completed');
      expect(output).toContain('event: response.done');
    } finally {
      if (previousTerminalTimeout === undefined) {
        delete process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS;
      } else {
        process.env.ROUTECODEX_HTTP_SSE_TERMINAL_CLOSE_TIMEOUT_MS = previousTerminalTimeout;
      }
    }
  });

  it('does not let stream snapshot env bypass client-response stage selector', async () => {
    const previousCapture = process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS;
    const previousStages = process.env.ROUTECODEX_SNAPSHOT_STAGES;
    const snapshots: Array<{ phase?: string; data?: Record<string, unknown> }> = [];

    process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = '1';
    process.env.ROUTECODEX_SNAPSHOT_STAGES = 'provider-request';

    try {
      jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
        captureResponsesRequestContextForRequest: async () => undefined,
        clearResponsesConversationByRequestId: async () => undefined,
        finalizeResponsesConversationRequestRetention: async () => undefined,
        recordResponsesResponseForRequest: async () => undefined,
        rebindResponsesConversationRequestId: async () => undefined,
        writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
        createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
        deriveFinishReasonNative: () => undefined,
        isToolCallContinuationResponseNative: () => false,
        updateResponsesContractProbeFromSseChunkNative: (_chunk: unknown, probe: unknown) => probe,
        buildResponsesTerminalSseFramesFromProbeNative: () => [],
        importCoreDist: async () => createMockCoreDistProjectionModule(),
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

      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: { id: 'resp_stage_selector', status: 'completed' }
        } as any,
        'req-client-response-stage-selector',
        {
          entryEndpoint: '/v1/responses',
          responsesRequestContext: { payload: {}, context: { toolsRaw: [] } }
        }
      );

      expect(snapshots).toHaveLength(0);
      expect(res.jsonBody).toEqual({ id: 'resp_stage_selector', status: 'completed' });
    } finally {
      if (previousCapture === undefined) {
        delete process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS;
      } else {
        process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = previousCapture;
      }
      if (previousStages === undefined) {
        delete process.env.ROUTECODEX_SNAPSHOT_STAGES;
      } else {
        process.env.ROUTECODEX_SNAPSHOT_STAGES = previousStages;
      }
    }
  });

  it('passes required_action stream frames through without handler-side repair', async () => {
    jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', () => ({
      captureResponsesRequestContextForRequest: async () => undefined,
      clearResponsesConversationByRequestId: async () => undefined,
      finalizeResponsesConversationRequestRetention: async () => undefined,
      recordResponsesResponseForRequest: async () => undefined,
      rebindResponsesConversationRequestId: async () => undefined,
      writeSnapshotViaHooks: async () => undefined,
      projectSseErrorEventPayloadNative: (input: any) => ({
        type: 'error',
        status: input.status,
        error: {
          ...(input.error ?? {}),
          message: input.message,
          code: input.code,
          request_id: input.error?.request_id ?? input.requestId,
        },
      }),
      createResponsesJsonToSseConverter: async () => mockResponsesJsonToSseConverter(),
      deriveFinishReasonNative: () => undefined,
      isToolCallContinuationResponseNative: () => false,
      updateResponsesContractProbeFromSseChunkNative: (chunk: unknown, probe: unknown) => {
        const next = { ...((probe && typeof probe === 'object') ? probe as Record<string, unknown> : {}) };
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        if (text.includes('event: response.required_action') || text.includes('"type":"response.required_action"')) {
          next.__seen_response_required_action = true;
        }
        if (text.includes('event: response.completed') || text.includes('"type":"response.completed"')) {
          next.__seen_response_completed = true;
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
        ...(probe?.__seen_response_completed ? [] : [
          'event: response.completed\n' +
            'data: {"type":"response.completed","response":{"id":"resp_tool","object":"response","status":"requires_action"}}\n\n'
        ]),
        ...(probe?.__seen_response_done ? [] : [
          'event: response.done\n' +
            'data: {"type":"response.done","response":{"id":"resp_tool","object":"response","status":"requires_action"}}\n\n'
        ]),
        ...(probe?.__seen_done_chunk ? [] : ['data: [DONE]\n\n'])
      ],
      importCoreDist: async () => createMockCoreDistProjectionModule(),
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
        sseStream: stream
      } as any,
      'req-required-action-no-completed-repair',
      { forceSSE: true, entryEndpoint: '/v1/responses' }
    );

    stream.write('event: response.required_action\n');
    stream.write('data: {"type":"response.required_action","sequence_number":105,"response":{"id":"resp_tool","object":"response","status":"requires_action"},"required_action":{"submit_tool_outputs":{"tool_calls":[{"id":"call_tool_repair","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}}\n\n');
    stream.end();

    await finished;

    const output = chunks.join('');
    expect(output).toContain('event: response.required_action');
    expect(output).not.toContain('event: response.output_item.added');
    expect(output).not.toContain('event: response.function_call_arguments.delta');
    expect(output).not.toContain('event: response.function_call_arguments.done');
    expect(output).not.toContain('event: response.output_item.done');
    expect(output).not.toContain('event: response.completed');
    expect(output).not.toContain('event: response.done');
    expect(output).not.toContain('data: [DONE]');
  });
});
