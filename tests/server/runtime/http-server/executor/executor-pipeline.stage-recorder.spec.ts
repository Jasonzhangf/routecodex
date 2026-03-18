import { jest } from '@jest/globals';

const createSnapshotRecorderMock = jest.fn();

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', () => ({
  createSnapshotRecorder: createSnapshotRecorderMock
}));

describe('executor-pipeline stage recorder injection', () => {
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
});

