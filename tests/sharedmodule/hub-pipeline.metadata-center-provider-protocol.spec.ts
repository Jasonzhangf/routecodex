import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const executeRequestStagePipelineMock = jest.fn(async ({ normalized }: Record<string, any>) => ({
  providerPayload: normalized.payload,
  metadata: normalized.metadata,
  outputMetadata: normalized.metadata,
  standardizedRequest: normalized.payload,
  entryOriginRequest: normalized.payload,
  effects: [],
  diagnostics: [],
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js',
  () => ({
    createVirtualRouterRuntime: () => ({
      initialize: jest.fn(),
      updateDeps: jest.fn(),
      registerProviderRuntimeIngress: jest.fn(),
      unregisterProviderRuntimeIngress: jest.fn(),
    }),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.js',
  () => ({
    executeRequestStagePipeline: executeRequestStagePipelineMock,
  })
);

const { HubPipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js'
);

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/hub-pipeline.metadata-center-provider-protocol.spec.ts',
  symbol: 'bindProviderProtocol',
  stage: 'test_runtime_control_provider_protocol'
} as const;

describe('HubPipeline metadata center providerProtocol contract', () => {
  beforeEach(() => {
    executeRequestStagePipelineMock.mockClear();
  });

  it('prefers bound MetadataCenter runtimeControl.providerProtocol over flat metadata', async () => {
    const metadata: Record<string, unknown> = {
      providerProtocol: 'openai-chat',
      entryEndpoint: '/v1/responses',
      direction: 'request',
      stage: 'inbound'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      TEST_METADATA_WRITER,
      'test-provider-protocol'
    );

    const pipeline = new HubPipeline({
      virtualRouter: {} as any
    });

    try {
      await pipeline.execute({
        id: 'req-metadata-center-provider-protocol',
        endpoint: '/v1/responses',
        payload: {
          model: 'gpt-test',
          input: 'hi'
        },
        metadata
      } as any);

      expect(executeRequestStagePipelineMock).toHaveBeenCalledWith(expect.objectContaining({
        normalized: expect.objectContaining({
          providerProtocol: 'openai-responses',
          metadata: expect.objectContaining({
            providerProtocol: 'openai-responses',
          }),
        }),
      }));
    } finally {
      pipeline.dispose();
    }
  });
});
