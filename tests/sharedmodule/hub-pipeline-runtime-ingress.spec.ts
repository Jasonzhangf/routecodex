import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const nativeCalls = {
  create: jest.fn<(inputJson: string) => string>(),
  execute: jest.fn<(handle: string, requestJson: string) => string>(),
  dispose: jest.fn<(handle: string) => void>(),
  updateConfig: jest.fn<(handle: string, configJson: string) => void>(),
  updateDeps: jest.fn<(handle: string, depsJson: string) => void>(),
  resolveProtocol: jest.fn<(input: { providerProtocol?: unknown; runtimeControl?: Record<string, unknown> | null }) => { providerProtocol: string }>(),
  materializeRequest: jest.fn<(input: {
    endpoint: string;
    providerProtocol: string;
    metadata: Record<string, unknown>;
    payload: Record<string, unknown>;
    payloadStream: boolean;
  }) => {
    endpoint: string;
    entryEndpoint: string;
    providerProtocol: string;
    metadata: Record<string, unknown>;
    processMode: 'chat';
    direction: 'request' | 'response';
    stage: 'inbound' | 'outbound';
    stream: boolean;
    disableSnapshots: boolean;
  }>(),
};

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.js', () => ({
  createHubPipelineEngineJson: nativeCalls.create,
  hubPipelineExecuteJson: nativeCalls.execute,
  disposeHubPipelineEngineJson: nativeCalls.dispose,
  updateHubPipelineVirtualRouterConfigJson: nativeCalls.updateConfig,
  updateHubPipelineEngineDepsJson: nativeCalls.updateDeps,
  resolveHubPipelineRequestProviderProtocolWithNative: nativeCalls.resolveProtocol,
  buildHubPipelineMaterializedRequestPlanWithNative: nativeCalls.materializeRequest,
}));

const { HubPipeline } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js');

describe('HubPipeline runtime ingress wiring', () => {
  beforeEach(() => {
    for (const call of Object.values(nativeCalls)) {
      call.mockReset();
    }
    nativeCalls.create.mockReturnValue(JSON.stringify({ handle: 'hp_test' }));
    nativeCalls.execute.mockReturnValue(JSON.stringify({ requestId: 'req_1', success: true, metadata: {}, nodeResults: [] }));
    nativeCalls.resolveProtocol.mockReturnValue({ providerProtocol: 'openai-chat' });
    nativeCalls.materializeRequest.mockImplementation((input) => ({
      endpoint: input.endpoint,
      entryEndpoint: input.endpoint,
      providerProtocol: input.providerProtocol,
      metadata: input.metadata,
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
      stream: input.payloadStream,
      disableSnapshots: false,
    }));
  });

  it('creates and disposes the native HubPipeline engine handle', () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });

    expect(nativeCalls.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(nativeCalls.create.mock.calls[0]![0])).toEqual({ virtualRouter: {} });

    pipeline.dispose();

    expect(nativeCalls.dispose).toHaveBeenCalledWith('hp_test');
  });

  it('fails fast when native engine deps update fails', () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    nativeCalls.updateDeps.mockImplementationOnce(() => {
      throw new Error('native deps rejected');
    });

    expect(() => pipeline.updateRuntimeDeps({ healthStore: null })).toThrow('native deps rejected');
  });

  it('fails fast when native engine dispose fails', () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    nativeCalls.dispose.mockImplementationOnce(() => {
      throw new Error('native dispose rejected');
    });

    expect(() => pipeline.dispose()).toThrow('native dispose rejected');
  });

  it('uses native providerProtocol resolver before executing', async () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    await pipeline.execute({
      id: 'req_native_protocol',
      endpoint: '/v1/responses',
      payload: { model: 'gpt-test' },
      metadata: {
        providerProtocol: 'responses',
        metadataCenterSnapshot: {
          runtimeControl: { providerProtocol: 'openai-responses' },
        },
      },
    });

    expect(nativeCalls.resolveProtocol).toHaveBeenCalledWith({
      providerProtocol: 'responses',
      runtimeControl: { providerProtocol: 'openai-responses' },
    });
    expect(nativeCalls.materializeRequest).toHaveBeenCalledWith({
      endpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      metadata: {
        providerProtocol: 'responses',
        metadataCenterSnapshot: {
          runtimeControl: { providerProtocol: 'openai-responses' },
        },
      },
      payload: { model: 'gpt-test' },
      payloadStream: false,
    });
    expect(JSON.parse(nativeCalls.execute.mock.calls[0]![1]).providerProtocol).toBe('openai-chat');
  });

  it('keeps HubPipeline native engine bridge owner names queryable by function map', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts',
      'utf8',
    );

    for (const bridgeName of [
      'createHubPipelineEngineJson',
      'hubPipelineExecuteJson',
      'disposeHubPipelineEngineJson',
      'updateHubPipelineVirtualRouterConfigJson',
      'updateHubPipelineEngineDepsJson',
    ]) {
      expect(source).toContain(bridgeName);
    }
  });
});
