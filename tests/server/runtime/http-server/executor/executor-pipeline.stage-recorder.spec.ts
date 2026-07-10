import { jest } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const createSnapshotRecorderMock = jest.fn();
const executeHubPipelineNativeMock = jest.fn();
const buildRequestStageRuntimeControlWritePlanNativeMock = jest.fn((input: {
  outputMetadata?: Record<string, unknown>;
}) => {
  const runtimeControl = input.outputMetadata?.runtime_control;
  return {
    runtimeControl:
      runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)
        ? runtimeControl as Record<string, unknown>
        : null
  };
});
const resolveEntryProtocolFromEndpointNativeMock = jest.fn((entryEndpoint: string) => {
  if (entryEndpoint === '/v1/chat/completions') {
    return 'openai-chat';
  }
  if (entryEndpoint === '/v1/responses') {
    return 'openai-responses';
  }
  if (entryEndpoint === '/v1/messages') {
    return 'anthropic-messages';
  }
  throw new Error(`Unsupported hub pipeline entry endpoint: ${entryEndpoint}`);
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: createSnapshotRecorderMock
}));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/routing-integrations.js', () => ({
  executeHubPipelineNative: executeHubPipelineNativeMock
}));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
  buildRequestStageRuntimeControlWritePlanNative: buildRequestStageRuntimeControlWritePlanNativeMock,
  resolveEntryProtocolFromEndpointNative: resolveEntryProtocolFromEndpointNativeMock
}));

describe('executor-pipeline stage recorder injection', () => {
  const previousHubStageRecorder = process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER;

  beforeAll(() => {
    process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER = '1';
  });

  afterAll(() => {
    if (previousHubStageRecorder === undefined) {
      delete process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER;
    } else {
      process.env.ROUTECODEX_ENABLE_HUB_STAGE_RECORDER = previousHubStageRecorder;
    }
  });

  beforeEach(() => {
    createSnapshotRecorderMock.mockReset();
    executeHubPipelineNativeMock.mockReset();
    buildRequestStageRuntimeControlWritePlanNativeMock.mockClear();
    resolveEntryProtocolFromEndpointNativeMock.mockClear();
  });

  it('injects bridge stage recorder into hub pipeline metadata', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    executeHubPipelineNativeMock.mockReturnValue({
      providerPayload: { ok: true },
      target: {
        providerKey: 'provider.a',
        providerType: 'openai',
        outboundProfile: 'openai-chat'
      },
      processMode: 'chat',
      metadata: {}
    });

    await runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stage_recorder_1',
        entryEndpoint: '/v1/chat/completions',
        headers: {},
        body: { messages: [{ role: 'user', content: 'hi' }] },
        metadata: {}
      } as any,
      { clientInjectReady: true }
    );

    expect(createSnapshotRecorderMock).toHaveBeenCalledWith(
      {
        requestId: 'req_stage_recorder_1',
        providerProtocol: 'openai-chat'
      },
      '/v1/chat/completions'
    );
    const executeArg = executeHubPipelineNativeMock.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(executeArg.metadata?.clientInjectReady).toBe(true);
    expect(executeArg.metadata?.__hubStageRecorder).toBe(recorder);
  });

  it('uses the entry endpoint as the only protocol truth for stage recorder setup', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    executeHubPipelineNativeMock.mockReturnValue({
      providerPayload: { ok: true },
      target: {
        providerKey: 'provider.a',
        providerType: 'openai',
        outboundProfile: 'openai-chat'
      },
      processMode: 'chat',
      metadata: {}
    });

    await runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stage_recorder_entry_truth_1',
        entryEndpoint: '/v1/responses',
        headers: {},
        body: { input: 'hi' },
        metadata: {}
      } as any,
      { providerProtocol: 'openai-chat' }
    );

    expect(createSnapshotRecorderMock).toHaveBeenCalledWith(
      {
        requestId: 'req_stage_recorder_entry_truth_1',
        providerProtocol: 'openai-responses'
      },
      '/v1/responses'
    );
  });

  it('fails fast when hub pipeline entry endpoint is unsupported', async () => {
    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    await expect(runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stage_recorder_bad_entry_1',
        entryEndpoint: '/v1/unknown',
        headers: {},
        body: { input: 'hi' },
        metadata: {}
      } as any,
      {}
    )).rejects.toThrow('Unsupported hub pipeline entry endpoint: /v1/unknown');

    expect(executeHubPipelineNativeMock).not.toHaveBeenCalled();
  });

  it('preserves MetadataCenter binding without mutating relay metadata', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    executeHubPipelineNativeMock.mockReturnValue({
      providerPayload: { ok: true },
      target: {
        providerKey: 'provider.a',
        providerType: 'openai',
        outboundProfile: 'openai-chat'
      },
      processMode: 'chat',
      metadata: {}
    });

    const metadata: Record<string, unknown> = { clientInjectReady: true };
    MetadataCenter.attach(metadata).writeRuntimeControl(
          'stopMessageEnabled',
          true,
          {
            module: 'tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts',
        symbol: 'preserves MetadataCenter binding without mutating relay metadata',
        stage: 'test'
      }
    );

    await runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stage_recorder_no_clone_1',
        entryEndpoint: '/v1/chat/completions',
        headers: {},
        body: { messages: [{ role: 'user', content: 'hi' }] },
        metadata: {}
      } as any,
      metadata
    );

    const executeArg = executeHubPipelineNativeMock.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(executeArg.metadata).not.toBe(metadata);
    expect(metadata.__hubStageRecorder).toBeUndefined();
    expect(executeArg.metadata?.__hubStageRecorder).toBe(recorder);
    expect(MetadataCenter.read(executeArg.metadata)?.readRuntimeControl()).toMatchObject({
      stopMessageEnabled: true
    });
  });

  it('projects MetadataCenter runtime control into native dispatch snapshot', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    executeHubPipelineNativeMock.mockReturnValue({
      providerPayload: { ok: true },
      target: {
        providerKey: 'provider.a',
        providerType: 'openai',
        outboundProfile: 'openai-responses'
      },
      routingDecision: {
        routeName: 'thinking',
        providerProtocol: 'openai-responses'
      },
      processMode: 'chat',
      metadata: {}
    });

    const metadata: Record<string, unknown> = { clientInjectReady: true };
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts',
        symbol: 'projects MetadataCenter runtime control into native dispatch snapshot',
        stage: 'test'
      },
      'test selected provider protocol'
    );

    await runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stage_recorder_provider_protocol_snapshot_1',
        entryEndpoint: '/v1/responses',
        headers: {},
        body: { input: 'hi' },
        metadata: {}
      } as any,
      metadata
    );

    const executeArg = executeHubPipelineNativeMock.mock.calls[0]?.[1] as {
      metadata?: Record<string, unknown>;
      metadataCenterSnapshot?: Record<string, unknown>;
    };
    expect(executeArg.metadataCenterSnapshot).toMatchObject({
      runtimeControl: {
        providerProtocol: 'openai-responses'
      }
    });
    expect(executeArg.metadata?.metadataCenterSnapshot).toMatchObject({
      runtimeControl: {
        providerProtocol: 'openai-responses'
      }
    });
    expect(metadata.metadataCenterSnapshot).toBeUndefined();
  });

  it('writes Rust request-stage stopless runtime control back to the bound MetadataCenter', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    const continuationPrompt = '运行 cargo test 验证 stopless next_step';
    executeHubPipelineNativeMock.mockReturnValue({
      providerPayload: { ok: true },
      target: {
        providerKey: 'provider.a',
        providerType: 'openai',
        outboundProfile: 'openai-responses'
      },
      processMode: 'chat',
      metadata: {
        runtime_control: {
          stopless: {
            active: true,
            flowId: 'stop_message_flow',
            repeatCount: 1,
            maxRepeats: 3,
            triggerHint: 'non_terminal_schema',
            continuationPrompt,
            schemaFeedback: {
              reasonCode: 'stop_schema_continue_next_step',
              missingFields: []
            }
          }
        }
      }
    });

    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_stopless_next_step_writeback',
      {
        module: 'tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts',
        symbol: 'writes Rust request-stage stopless runtime control back to the bound MetadataCenter',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_stopless_next_step_writeback',
      {
        module: 'tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts',
        symbol: 'writes Rust request-stage stopless runtime control back to the bound MetadataCenter',
        stage: 'test'
      }
    );

    const result = await runHubPipeline(
      'mock_hub_pipeline_handle',
      {
        requestId: 'req_stopless_next_step_writeback',
        entryEndpoint: '/v1/responses',
        headers: {},
        body: { input: 'hi' },
        metadata: {}
      } as any,
      metadata
    );

    expect(buildRequestStageRuntimeControlWritePlanNativeMock).toHaveBeenCalledWith({
      outputMetadata: expect.objectContaining({
        runtime_control: expect.objectContaining({
          stopless: expect.objectContaining({
            continuationPrompt
          })
        })
      })
    });
    expect(MetadataCenter.read(metadata)?.readRuntimeControl().stopless).toEqual(expect.objectContaining({
      continuationPrompt,
      schemaFeedback: expect.objectContaining({
        reasonCode: 'stop_schema_continue_next_step'
      })
    }));
    expect(result.metadata.metadataCenterSnapshot).toMatchObject({
      requestTruth: {
        requestId: 'req_stopless_next_step_writeback',
        sessionId: 'sess_stopless_next_step_writeback'
      },
      runtimeControl: {
        stopless: expect.objectContaining({
          continuationPrompt
        })
      }
    });
  });
});
