import { describe, expect, it, jest } from '@jest/globals';
import { STREAM_LOG_FINISH_REASON_KEY } from '../../../../../src/server/utils/finish-reason.js';
import {
  REASONING_STOP_FINALIZED_FLAG_KEY
} from '../../../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js';
import { PassThrough } from 'node:stream';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
jest.mock('../../../../../src/modules/llmswitch/bridge.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
}));

describe('provider-response-converter finish reason wrapper metadata', () => {
  it('preserves derived finish_reason for streamed responses logs', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      __sse_responses: sseStream,
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

    expect((converted.body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY]).toBe('tool_calls');
    expect((converted.body as Record<string, unknown>).__sse_responses).toBe(sseStream);
  });

  it('preserves reasoning.stop finalized marker state on streamed wrapper bodies', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      __sse_responses: sseStream,
      body: {
        id: 'chatcmpl_reasoning_stop_finalized',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '[app.finished:reasoning.stop] {\"is_completed\":true}'
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

    expect((converted.body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY]).toBe('stop');
    expect((converted.body as Record<string, unknown>)[REASONING_STOP_FINALIZED_FLAG_KEY]).toBe(true);
    expect((converted.body as Record<string, unknown>).__sse_responses).toBe(sseStream);
  });

  it('does not set streamed finalized flag from hidden metadata marker only', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      __sse_responses: sseStream,
      body: {
        id: 'chatcmpl_reasoning_stop_hidden_marker_only',
        object: 'chat.completion',
        metadata: {
          hidden: '[app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
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

    expect((converted.body as Record<string, unknown>)[STREAM_LOG_FINISH_REASON_KEY]).toBe('stop');
    expect((converted.body as Record<string, unknown>)[REASONING_STOP_FINALIZED_FLAG_KEY]).toBeUndefined();
    expect((converted.body as Record<string, unknown>).__sse_responses).toBe(sseStream);
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
      __sse_responses: anthropicRawSse,
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
          body: { __sse_responses: anthropicRawSse }
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

    const wrappedBody = converted.body as Record<string, unknown>;
    expect(wrappedBody.__sse_responses).toBeDefined();
    expect(wrappedBody[STREAM_LOG_FINISH_REASON_KEY]).toBe('stop');
    expect((wrappedBody as Record<string, unknown>).output_text).toBeUndefined();
    expect((wrappedBody as Record<string, unknown>).status).toBeUndefined();
  });

});
