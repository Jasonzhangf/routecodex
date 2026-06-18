import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough, Readable } from 'node:stream';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockDeriveFinishReasonNative = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.choices)) {
    const first = record.choices[0] as Record<string, unknown> | undefined;
    return typeof first?.finish_reason === 'string' ? first.finish_reason : undefined;
  }
  if (record.status === 'requires_action' || record.required_action) {
    return 'tool_calls';
  }
  if (
    record.status === 'completed'
    || (typeof record.output_text === 'string' && record.output_text.trim())
    || (Array.isArray(record.output) && record.output.length > 0)
  ) {
    return 'stop';
  }
  return undefined;
};

const mockResolveRelayResponsesClientSseStreamForHttp = async (args: {
  body?: Record<string, unknown>;
  sseStream?: unknown;
  requestId?: string;
}) => {
  if (!args.body) {
    return args.sseStream;
  }
  const response = args.body;
  return Readable.from([
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
    `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
  ]);
};

const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  syncStoplessGoalStateFromRequest: () => null,
  readStoplessGoalState: () => null,
  persistStoplessGoalStateSnapshot: () => undefined,
  createResponsesJsonToSseConverter: async () => ({
    convertResponseToJsonToSse: async (payload: any, options: Record<string, unknown>) => {
      const response = payload && typeof payload === 'object'
        ? payload
        : { id: 'resp_from_test_converter', object: 'response', status: 'completed', output: [], output_text: '' };
      const requestId = typeof options.requestId === 'string' ? options.requestId : 'req_test';
      const terminalType = response.status === 'requires_action' ? 'response.required_action' : 'response.completed';
      const terminalPayload =
        response.status === 'requires_action'
          ? { type: 'response.required_action', response, required_action: response.required_action }
          : { type: 'response.completed', response };
      return Readable.from([
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: response.id ?? requestId, object: 'response', status: 'in_progress' } })}\n\n`,
        `event: ${terminalType}\ndata: ${JSON.stringify(terminalPayload)}\n\n`,
        `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`,
      ]);
    }
  }),
  deriveFinishReasonNative: mockDeriveFinishReasonNative,
  updateResponsesContractProbeFromSseChunkNative: () => ({}),
  buildResponsesTerminalSseFramesFromProbeNative: () => [],
  resolveRelayResponsesClientSseStreamForHttp: mockResolveRelayResponsesClientSseStreamForHttp,
  requireCoreDist: () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload,
    buildResponsesPayloadFromChatWithNative: () => ({
      id: 'resp_from_native_chat_builder',
      object: 'response',
      status: 'completed',
      output: [],
      output_text: ''
    })
  }),
  importCoreDist: async () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload,
    buildResponsesPayloadFromChatWithNative: () => ({
      id: 'resp_from_native_chat_builder',
      object: 'response',
      status: 'completed',
      output: [],
      output_text: ''
    })
  })
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/index.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/index.ts', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/module-loader.js', () => ({
  requireCoreDist: () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload,
    buildResponsesPayloadFromChatWithNative: () => ({
      id: 'resp_from_native_chat_builder',
      object: 'response',
      status: 'completed',
      output: [],
      output_text: ''
    })
  }),
  importCoreDist: async (subpath: string) => {
    if (subpath === 'conversion/hub/response/provider-response') {
      return { convertProviderResponse: mockConvertProviderResponse };
    }
    return {};
  },
  resolveImplForSubpath: () => 'ts',
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/module-loader.ts', () => ({
  requireCoreDist: () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload,
    buildResponsesPayloadFromChatWithNative: () => ({
      id: 'resp_from_native_chat_builder',
      object: 'response',
      status: 'completed',
      output: [],
      output_text: ''
    })
  }),
  importCoreDist: async (subpath: string) => {
    if (subpath === 'conversion/hub/response/provider-response') {
      return { convertProviderResponse: mockConvertProviderResponse };
    }
    return {};
  },
  resolveImplForSubpath: () => 'ts',
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/response-converter.js', () => ({
  convertProviderResponse: mockConvertProviderResponse
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/response-converter.ts', () => ({
  convertProviderResponse: mockConvertProviderResponse
}));

describe('provider-response-converter prebuilt SSE passthrough gate', () => {
  it('does not bridge openai responses prebuilt SSE through stopless in the converter', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const prebuiltSse = new PassThrough();
    prebuiltSse.end(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_prebuilt_stop_1","status":"completed","output_text":"阶段完成"}}\n\n'
    );
    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_prebuilt_sse_default_stopless_no_goal',
        wantsStream: true,
        serverToolsEnabled: true,
        entryOriginRequest: {
          model: 'gpt-test',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行当前目标' }] }]
        },
        response: {
          body: {
            status: 'completed',
            output_text: '阶段完成'
          },
          sseStream: prebuiltSse,
          continuationOwner: 'direct',
        } as any,
        pipelineMetadata: {
          routecodexPortStopMessageEnabled: true,
          stopMessageEnabled: true
        }
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();

    expect(converted.sseStream).toBe(prebuiltSse);
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
  });

  it('RED: relay /v1/responses prebuilt SSE must re-enter bridge instead of passthrough', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const relaySse = new PassThrough();
    relaySse.end(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_relay_prebuilt_1","status":"completed","output_text":"relay body"}}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: relaySse,
      body: {
        id: 'resp_relay_bridge_1',
        object: 'response',
        status: 'completed',
        output: [],
        output_text: 'relay body'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_relay_prebuilt_sse_must_bridge',
        wantsStream: true,
        response: {
          body: {
            id: 'resp_relay_upstream_1',
            object: 'response',
            status: 'completed',
            output: [],
            output_text: 'relay upstream'
          },
          sseStream: relaySse,
          continuationOwner: 'relay',
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(relaySse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect((converted as any).body).toMatchObject({
      id: 'resp_relay_bridge_1',
      object: 'response',
      status: 'completed'
    });
  });

  it('RED: does not passthrough anthropic raw SSE directly on /v1/responses', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const anthropicRawSse = new PassThrough();
    anthropicRawSse.end(
      'event: message_start\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","type":"message"}}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: anthropicRawSse,
      body: {
        id: 'resp_from_anthropic_stream_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_out_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        output_text: 'ok'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_anthropic_raw_sse_must_wrap_for_responses',
        wantsStream: true,
        response: {
          body: {},
          sseStream: anthropicRawSse,
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(anthropicRawSse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).not.toContain('event: message_stop');
    expect(sseBody).not.toContain('event: message_start');
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
  });

  it('RED: stream-only relay /v1/responses must still enter bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const anthropicRawSse = new PassThrough();
    anthropicRawSse.end(
      'event: message_start\n'
      + 'data: {"type":"message_start","message":{"id":"msg_stream_only_1","type":"message"}}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: anthropicRawSse,
      body: {
        id: 'resp_stream_only_bridge_1',
        object: 'response',
        status: 'completed',
        output: [],
        output_text: 'stream-only relay body'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_stream_only_relay_must_bridge',
        wantsStream: true,
        response: {
          sseStream: anthropicRawSse,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8'
          }
        } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(anthropicRawSse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).not.toContain('event: message_stop');
    expect((converted as any).body).toMatchObject({
      id: 'resp_stream_only_bridge_1',
      object: 'response',
      status: 'completed'
    });
  });

});
