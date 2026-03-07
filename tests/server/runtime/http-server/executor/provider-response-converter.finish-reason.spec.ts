import { describe, expect, it, jest } from '@jest/globals';
import { STREAM_LOG_FINISH_REASON_KEY } from '../../../../../src/server/utils/finish-reason.js';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder
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
});
