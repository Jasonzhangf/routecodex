import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';

import { STREAM_LOG_FINISH_REASON_KEY } from '../../../../../src/server/utils/finish-reason.js';

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
  syncStoplessGoalStateFromRequest: () => null,
  readStoplessGoalState: () => null,
  persistStoplessGoalStateSnapshot: () => undefined,
  deriveFinishReasonNative: mockDeriveFinishReasonNative,
  updateResponsesContractProbeFromSseChunkNative: () => ({}),
  buildResponsesTerminalSseFramesFromProbeNative: () => [],
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

describe('provider-response-converter prebuilt SSE passthrough gate', () => {
  it('bridges openai responses prebuilt SSE stop through default stopless even without goal state', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const prebuiltSse = new PassThrough();
    prebuiltSse.end(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_prebuilt_stop_1","status":"completed","output_text":"阶段完成"}}\n\n'
    );
    const convertedSse = new PassThrough();
    convertedSse.end(
      'event: response.output_item.done\n'
      + 'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command","call_id":"call_stopless_cli_1","arguments":"{}"}}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      __sse_responses: convertedSse,
      body: {
        id: 'resp_stopless_cli_projection_1',
        object: 'response',
        status: 'requires_action',
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_stopless_cli_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({
                    cmd: 'routecodex servertool run stop_message_auto --input-json \'{"flowId":"stop_message_flow"}\''
                  })
                }
              }
            ]
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
            __sse_responses: prebuiltSse,
            status: 'completed',
            output_text: '阶段完成'
          }
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

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(bridgeArgs.providerProtocol).toBe('openai-responses');
    expect(bridgeArgs.clientInjectDispatch).toBeDefined();

    const wrappedBody = converted.body as Record<string, unknown>;
    expect(wrappedBody.__sse_responses).toBe(convertedSse);
    expect(wrappedBody[STREAM_LOG_FINISH_REASON_KEY]).toBe('tool_calls');
    expect(wrappedBody.__sse_responses).not.toBe(prebuiltSse);
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
    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    expect(wrappedBody.__sse_responses).toBeDefined();
    expect(wrappedBody[STREAM_LOG_FINISH_REASON_KEY]).toBe('stop');
    expect(wrappedBody.output_text).toBeUndefined();
    expect(wrappedBody.status).toBeUndefined();
  });
});
