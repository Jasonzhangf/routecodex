import { describe, expect, it, jest } from '@jest/globals';
import { STREAM_LOG_FINISH_REASON_KEY } from '../../../../../src/server/utils/finish-reason.js';
import {
  REASONING_STOP_FINALIZED_FLAG_KEY
} from '../../../../../src/server/runtime/http-server/executor/servertool-response-normalizer.js';
import {
  QWENCHAT_NONSTREAM_DELIVERY_KEY,
  QWENCHAT_SSE_PROBE_WRAPPER_KEY
} from '../../../../../src/providers/core/runtime/qwenchat-http-provider-helpers.js';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

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

  it('syncs qwenchat stream probe metadata from streamed wrapper body back to pipeline metadata', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sseStream = { pipe: () => undefined };
    mockConvertProviderResponse.mockResolvedValue({
      __sse_responses: sseStream,
      body: {
        id: 'chatcmpl_qwen_probe',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: '' }
          }
        ]
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const pipelineMetadata: Record<string, unknown> = {};
    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_stream_qwen_probe',
        wantsStream: true,
        response: {
          body: {
            __sse_responses: sseStream,
            [QWENCHAT_SSE_PROBE_WRAPPER_KEY]: {
              firstEmitMs: 62000,
              firstToolCallMs: 62001,
              ignoredFrameCount: 12
            }
          }
        } as any,
        pipelineMetadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((pipelineMetadata.__rt as Record<string, unknown>).qwenchatSseProbe).toMatchObject({
      firstEmitMs: 62000,
      firstToolCallMs: 62001,
      ignoredFrameCount: 12
    });
  });

  it('syncs qwenchat non-stream delivery mode back to pipeline metadata and strips internal marker from body', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async (response: Record<string, unknown>) => ({
      body: response
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const pipelineMetadata: Record<string, unknown> = {};
    const providerBody: Record<string, unknown> = {
      id: 'chatcmpl_qwen_nonstream',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: '' }
        }
      ],
      [QWENCHAT_NONSTREAM_DELIVERY_KEY]: 'json'
    };

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        requestId: 'req_qwen_nonstream_delivery',
        wantsStream: false,
        response: { body: providerBody } as any,
        pipelineMetadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((pipelineMetadata.__rt as Record<string, unknown>).qwenchatNonstreamDelivery).toBe('json');
    expect(providerBody[QWENCHAT_NONSTREAM_DELIVERY_KEY]).toBeUndefined();
  });
});
