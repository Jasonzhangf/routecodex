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

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    extractModelHintFromMetadataWithNative: jest.fn(() => undefined),
    resolveHubPipelineRequestProviderProtocolWithNative: jest.fn(({
      providerProtocol,
      runtimeControl
    }: {
      providerProtocol?: unknown;
      runtimeControl?: Record<string, unknown> | null;
    }) => ({
      providerProtocol: typeof runtimeControl?.providerProtocol === 'string'
        ? runtimeControl.providerProtocol
        : providerProtocol
    })),
    resolveSseProtocolWithNative: jest.fn((_metadata: unknown, providerProtocol: string) => providerProtocol),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    ensureRuntimeMetadata: jest.fn((carrier: Record<string, unknown>) => {
      const existing = carrier.__rt;
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return existing;
      }
      carrier.__rt = {};
      return carrier.__rt as Record<string, unknown>;
    }),
    readRuntimeMetadata: jest.fn(() => ({})),
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

  it('uses flat metadata providerProtocol when no MetadataCenter is bound', async () => {
    const pipeline = new HubPipeline({
      virtualRouter: {} as any
    });

    try {
      await pipeline.execute({
        id: 'req-flat-provider-protocol',
        endpoint: '/v1/responses',
        payload: {
          model: 'gpt-test',
          input: 'hi'
        },
        metadata: {
          providerProtocol: 'openai-responses',
          entryEndpoint: '/v1/responses',
          direction: 'request',
          stage: 'inbound'
        }
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
