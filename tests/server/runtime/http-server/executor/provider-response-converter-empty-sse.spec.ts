import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));

jest.mock('../../../../../src/modules/llmswitch/bridge.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: jest.fn(() => 'off'),
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
}));

describe('provider-response-converter empty OpenAI chat SSE failures', () => {
  it('remaps Rust empty OpenAI chat SSE parse failures to retryable SSE decode errors', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockRejectedValue(
      new Error('Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain JSON data events')
    );

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        providerType: 'openai',
        requestId: 'req_empty_openai_chat_sse_retryable',
        wantsStream: true,
        response: { body: { mode: 'sse', captureSse: true, transport: 'prepared-request-executor' } } as any,
        pipelineMetadata: {}
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    )).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
  });
});
