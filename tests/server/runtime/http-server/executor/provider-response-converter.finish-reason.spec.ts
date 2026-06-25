import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';

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

const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  deriveFinishReasonNative: mockDeriveFinishReasonNative,
  updateResponsesContractProbeFromSseChunkNative: () => ({}),
  buildResponsesTerminalSseFramesFromProbeNative: () => [],
  importCoreDist: async () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload
  }),
  requireCoreDist: () => ({
    normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) => payload
  })
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider-response-converter finish reason wrapper metadata', () => {
  it('does not bypass response-side servertool for streamed passthrough relay', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      sseStream: sseStream,
      body: {
        id: 'chatcmpl_passthrough_stream_stop',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '阶段完成' }
          }
        ]
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        providerType: 'openai',
        requestId: 'req_stream_chat_must_still_run_servertool',
        wantsStream: true,
        processMode: 'chat',
        serverToolsEnabled: true,
        response: { body: {}, sseStream: sseStream } as any,
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
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
    expect(converted.sseStream).toBe(sseStream);
  });

  it('preserves derived finish_reason for streamed responses logs', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      sseStream: sseStream,
      body: {
        status: 'requires_action',
        required_action: {
          submit_tool_outputs: {
            tool_calls: []
          }
        }
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_stream_finish_reason',
        wantsStream: true,
        response: { body: { id: 'upstream_body' } } as any,
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

    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
    expect(converted.sseStream).toBe(sseStream);
  });

  it('preserves reasoningStop finalized marker state on streamed wrapper bodies', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      sseStream: sseStream,
      body: {
        id: 'chatcmpl_reasoning_stop_finalized',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '[app.finished:reasoningStop] {\"is_completed\":true}'
            }
          }
        ]
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_stream_reasoning_stop_finalized',
        wantsStream: true,
        response: { body: { id: 'upstream_body' } } as any,
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

    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
    expect(converted.sseStream).toBe(sseStream);
  });

  it('does not set streamed finalized flag from hidden metadata marker only', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      sseStream: sseStream,
      body: {
        id: 'chatcmpl_reasoning_stop_hidden_marker_only',
        object: 'chat.completion',
        metadata: {
          hidden: '[app.finished:reasoningStop] {"tool":"reasoningStop","completed":true}'
        },
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '普通状态汇报，没有可见 completed marker'
            }
          }
        ]
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_stream_reasoning_stop_hidden_marker_only',
        wantsStream: true,
        response: { body: { id: 'upstream_body' } } as any,
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

    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
    expect(converted.sseStream).toBe(sseStream);
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

    expect(converted.sseStream).toBeDefined();
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
  });
});
