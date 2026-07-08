import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const nativeCalls = {
  create: jest.fn<(inputJson: string) => string>(),
  execute: jest.fn<(handle: string, requestJson: string) => string>(),
  dispose: jest.fn<(handle: string) => void>(),
  updateConfig: jest.fn<(handle: string, configJson: string) => void>(),
  updateDeps: jest.fn<(handle: string, depsJson: string) => void>(),
  route: jest.fn<(handle: string, requestJson: string, metadataJson: string) => string>(),
  diagnoseRoute: jest.fn<(handle: string, requestJson: string, metadataJson: string) => string>(),
  getStatus: jest.fn<(handle: string) => string>(),
  markConcurrencyScopeBusy: jest.fn<(handle: string, scopeKey: string) => void>(),
  materializeRequest: jest.fn<(input: {
    endpoint: string;
    providerProtocol: string;
    metadata: Record<string, unknown>;
    metadataCenterSnapshot?: Record<string, unknown> | null;
    payload: Record<string, unknown>;
    payloadStream: boolean;
  }) => {
    endpoint: string;
    entryEndpoint: string;
    providerProtocol: string;
    metadata: Record<string, unknown>;
    metadataCenterSnapshot?: Record<string, unknown> | null;
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
  hubPipelineVirtualRouterRouteJson: nativeCalls.route,
  hubPipelineVirtualRouterDiagnoseRouteJson: nativeCalls.diagnoseRoute,
  hubPipelineVirtualRouterStatusJson: nativeCalls.getStatus,
  hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson: nativeCalls.markConcurrencyScopeBusy,
  buildHubPipelineMaterializedRequestPlanWithNative: nativeCalls.materializeRequest,
}));

const { NativeHubPipelineTestWrapper: HubPipeline } = await import('../helpers/native-hub-pipeline-test-wrapper.js');

describe('HubPipeline runtime ingress wiring', () => {
  beforeEach(() => {
    for (const call of Object.values(nativeCalls)) {
      call.mockReset();
    }
    nativeCalls.create.mockReturnValue(JSON.stringify({ handle: 'hp_test' }));
    nativeCalls.execute.mockReturnValue(JSON.stringify({ requestId: 'req_1', success: true, metadata: {}, nodeResults: [] }));
    nativeCalls.route.mockReturnValue(JSON.stringify({
      target: { providerKey: 'primary.key1.gpt-test' },
      decision: { routeName: 'default', providerKey: 'primary.key1.gpt-test' },
      diagnostics: {}
    }));
    nativeCalls.diagnoseRoute.mockReturnValue(JSON.stringify({ ok: true }));
    nativeCalls.getStatus.mockReturnValue(JSON.stringify({ routes: {}, health: {}, forwarders: {} }));
    nativeCalls.materializeRequest.mockImplementation((input) => ({
      endpoint: input.endpoint,
      entryEndpoint: input.endpoint,
      providerProtocol: input.providerProtocol,
      metadata: input.metadata,
      ...(input.metadataCenterSnapshot ? { metadataCenterSnapshot: input.metadataCenterSnapshot } : {}),
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

  it('uses native materialized request plan before executing', async () => {
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

    expect(nativeCalls.materializeRequest).toHaveBeenCalledWith({
      endpoint: '/v1/responses',
      providerProtocol: 'responses',
      metadata: {
        providerProtocol: 'responses',
        metadataCenterSnapshot: {
          runtimeControl: { providerProtocol: 'openai-responses' },
        },
      },
      metadataCenterSnapshot: {
        runtimeControl: { providerProtocol: 'openai-responses' },
      },
      payload: { model: 'gpt-test' },
      payloadStream: false,
    });
    const requestJson = JSON.parse(nativeCalls.execute.mock.calls[0]![1]);
    expect(requestJson.providerProtocol).toBe('responses');
    expect(requestJson.metadataCenterSnapshot).toEqual({
      runtimeControl: { providerProtocol: 'openai-responses' },
    });
  });

  it('does not require selected providerProtocol before request-route selection', async () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    nativeCalls.materializeRequest.mockImplementationOnce((input) => ({
      endpoint: input.endpoint,
      entryEndpoint: input.endpoint,
      providerProtocol: 'openai-responses',
      metadata: input.metadata,
      ...(input.metadataCenterSnapshot ? { metadataCenterSnapshot: input.metadataCenterSnapshot } : {}),
      processMode: 'chat',
      direction: 'request',
      stage: 'inbound',
      stream: false,
      disableSnapshots: false,
    }));

    await pipeline.execute({
      id: 'req_route_before_provider_protocol',
      endpoint: '/v1/responses',
      payload: { model: 'gpt-test', input: 'hi' },
      metadata: {
        entryEndpoint: '/v1/responses',
        direction: 'request',
        stage: 'inbound',
      },
    });

    expect(nativeCalls.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(nativeCalls.execute.mock.calls[0]![1]).providerProtocol).toBe('openai-responses');
  });

  it('exposes virtual router operations through the native HubPipeline handle', () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    const router = pipeline.getVirtualRouter();

    const route = router.route({ model: 'gpt-test' }, { requestId: 'req_direct' });
    const diagnostics = router.diagnoseRoute({ model: 'gpt-test' }, { requestId: 'req_diag' });
    const status = router.getStatus();
    router.markConcurrencyScopeBusy('primary.key1.gpt-test');

    expect(route.decision?.providerKey).toBe('primary.key1.gpt-test');
    expect(diagnostics).toEqual({ ok: true });
    expect(status).toEqual({ routes: {}, health: {}, forwarders: {} });
    expect(nativeCalls.route).toHaveBeenCalledWith('hp_test', JSON.stringify({ model: 'gpt-test' }), JSON.stringify({ requestId: 'req_direct' }));
    expect(nativeCalls.diagnoseRoute).toHaveBeenCalledWith('hp_test', JSON.stringify({ model: 'gpt-test' }), JSON.stringify({ requestId: 'req_diag' }));
    expect(nativeCalls.getStatus).toHaveBeenCalledWith('hp_test');
    expect(nativeCalls.markConcurrencyScopeBusy).toHaveBeenCalledWith('hp_test', 'primary.key1.gpt-test');
  });

  it('keeps HubPipeline native engine bridge owner names queryable by function map', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      'src/modules/llmswitch/bridge/routing-integrations.ts',
      'utf8',
    );

    for (const bridgeName of [
      'createHubPipelineEngineJson',
      'hubPipelineExecuteJson',
      'disposeHubPipelineEngineJson',
      'updateHubPipelineVirtualRouterConfigJson',
      'updateHubPipelineEngineDepsJson',
      'hubPipelineVirtualRouterRouteJson',
      'hubPipelineVirtualRouterDiagnoseRouteJson',
      'hubPipelineVirtualRouterStatusJson',
      'hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson',
    ]) {
      expect(source).toContain(bridgeName);
    }
  });
});
