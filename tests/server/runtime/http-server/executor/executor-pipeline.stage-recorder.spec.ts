import { jest } from '@jest/globals';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const createSnapshotRecorderMock = jest.fn();

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', () => ({
  createSnapshotRecorder: createSnapshotRecorderMock
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
  });

  it('injects bridge stage recorder into hub pipeline metadata', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    const hubPipeline = {
      execute: jest.fn().mockResolvedValue({
        providerPayload: { ok: true },
        target: {
          providerKey: 'provider.a',
          providerType: 'openai',
          outboundProfile: 'openai-chat'
        },
        processMode: 'chat',
        metadata: {}
      })
    };

    await runHubPipeline(
      hubPipeline as any,
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
    const executeArg = hubPipeline.execute.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(executeArg.metadata?.clientInjectReady).toBe(true);
    expect(executeArg.metadata?.__hubStageRecorder).toBe(recorder);
  });

  it('uses the entry endpoint as the only protocol truth for stage recorder setup', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    const hubPipeline = {
      execute: jest.fn().mockResolvedValue({
        providerPayload: { ok: true },
        target: {
          providerKey: 'provider.a',
          providerType: 'openai',
          outboundProfile: 'openai-chat'
        },
        processMode: 'chat',
        metadata: {}
      })
    };

    await runHubPipeline(
      hubPipeline as any,
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

    const hubPipeline = {
      execute: jest.fn()
    };

    await expect(runHubPipeline(
      hubPipeline as any,
      {
        requestId: 'req_stage_recorder_bad_entry_1',
        entryEndpoint: '/v1/unknown',
        headers: {},
        body: { input: 'hi' },
        metadata: {}
      } as any,
      {}
    )).rejects.toThrow('Unsupported hub pipeline entry endpoint: /v1/unknown');

    expect(hubPipeline.execute).not.toHaveBeenCalled();
  });

  it('preserves MetadataCenter binding without mutating relay metadata', async () => {
    const recorder = { record: jest.fn() };
    createSnapshotRecorderMock.mockResolvedValue(recorder);

    const { runHubPipeline } = await import('../../../../../src/server/runtime/http-server/executor-pipeline.js');

    const hubPipeline = {
      execute: jest.fn().mockResolvedValue({
        providerPayload: { ok: true },
        target: {
          providerKey: 'provider.a',
          providerType: 'openai',
          outboundProfile: 'openai-chat'
        },
        processMode: 'chat',
        metadata: {}
      })
    };

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
      hubPipeline as any,
      {
        requestId: 'req_stage_recorder_no_clone_1',
        entryEndpoint: '/v1/chat/completions',
        headers: {},
        body: { messages: [{ role: 'user', content: 'hi' }] },
        metadata: {}
      } as any,
      metadata
    );

    const executeArg = hubPipeline.execute.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(executeArg.metadata).not.toBe(metadata);
    expect(metadata.__hubStageRecorder).toBeUndefined();
    expect(executeArg.metadata?.__hubStageRecorder).toBe(recorder);
    expect(MetadataCenter.read(executeArg.metadata)?.readRuntimeControl()).toMatchObject({
      stopMessageEnabled: true
    });
  });
});
