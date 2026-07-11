import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', () => ({
  convertProviderResponse: mockConvertProviderResponse,
}));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder,
}));

const { MetadataCenter } = await import(
  '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
);
const { convertProviderResponseIfNeeded } = await import(
  '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
);

describe('provider-response-converter metadata center providerProtocol contract', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConvertProviderResponse.mockResolvedValue({
      body: {
        id: 'msg_provider_response_converter_protocol_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'center protocol wins' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    });
  });

  it('prefers metadata center runtimeControl.providerProtocol when forwarding bridge conversion', async () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'providerProtocol',
      'anthropic-messages',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-converter.metadata-center-provider-protocol.spec.ts',
        symbol: 'prefers metadata center runtimeControl.providerProtocol when forwarding bridge conversion',
        stage: 'test'
      }
    );

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat',
        providerType: 'anthropic',
        requestId: 'req_provider_response_converter_protocol_1',
        wantsStream: false,
        response: {
          body: {
            id: 'msg_provider_response_converter_protocol_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'center protocol wins' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        } as any,
        pipelineMetadata: metadata
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledWith(expect.objectContaining({
      providerProtocol: 'anthropic-messages',
      context: expect.objectContaining({
        providerProtocol: 'anthropic-messages',
        metadataCenterSnapshot: expect.objectContaining({
          runtimeControl: expect.objectContaining({
            providerProtocol: 'anthropic-messages'
          })
        })
      })
    }));
  });
});
