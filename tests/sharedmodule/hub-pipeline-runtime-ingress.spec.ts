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
};

jest.unstable_mockModule('../../src/modules/llmswitch/bridge/routing-native-host.js', () => ({
  getRouterHotpathJsonBindingSync: () => ({
    createHubPipelineEngineJson: nativeCalls.create,
    hubPipelineExecuteJson: nativeCalls.execute,
    disposeHubPipelineEngineJson: nativeCalls.dispose,
    updateHubPipelineVirtualRouterConfigJson: nativeCalls.updateConfig,
    updateHubPipelineEngineDepsJson: nativeCalls.updateDeps,
    hubPipelineVirtualRouterRouteJson: nativeCalls.route,
    hubPipelineVirtualRouterDiagnoseRouteJson: nativeCalls.diagnoseRoute,
    hubPipelineVirtualRouterStatusJson: nativeCalls.getStatus,
    hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson: nativeCalls.markConcurrencyScopeBusy,
    resolveRccUserDirJson: jest.fn(() => JSON.stringify('/tmp/rcc-test')),
    planVirtualRouterRouteHostEffectsJson: jest.fn((requestJson: string) => JSON.stringify({
      cleanedRequest: JSON.parse(requestJson),
      forceStopStatusLabel: false,
      hitLogDisabled: false,
    })),
    finalizeVirtualRouterRouteHostEffectsJson: jest.fn(() => JSON.stringify('[virtual-router-hit] test')),
  }),
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(),
  resolveEntryProtocolFromEndpointNative: jest.fn(),
}));

const { NativeHubPipelineTestWrapper: HubPipeline } = await import('../helpers/native-hub-pipeline-test-wrapper.js');

// feature_id: hub.runtime_ingress_bridge
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

  it('passes request payload directly into the native HubPipeline engine', async () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
    const request = {
      id: 'req_native_protocol',
      endpoint: '/v1/responses',
      payload: { model: 'gpt-test' },
      metadata: {
        providerProtocol: 'responses',
        metadataCenterSnapshot: {
          runtimeControl: { providerProtocol: 'openai-responses' },
        },
      },
    };
    await pipeline.execute(request);

    const requestJson = JSON.parse(nativeCalls.execute.mock.calls[0]![1]);
    expect(requestJson).toEqual(request);
  });

  it('does not require selected providerProtocol before entering the native engine', async () => {
    const pipeline = new HubPipeline({ virtualRouter: {} });
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
    expect(JSON.parse(nativeCalls.execute.mock.calls[0]![1])).toMatchObject({
      metadata: {
        entryEndpoint: '/v1/responses',
        direction: 'request',
        stage: 'inbound',
      },
    });
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
    expect(nativeCalls.route).toHaveBeenCalledWith(
      'hp_test',
      JSON.stringify({ model: 'gpt-test' }),
      expect.stringContaining('"requestId":"req_direct"'),
    );
    expect(JSON.parse(nativeCalls.route.mock.calls[0]![2])).toMatchObject({
      requestId: 'req_direct',
      __rt: { rccUserDir: '/tmp/rcc-test' },
    });
    expect(nativeCalls.diagnoseRoute).toHaveBeenCalledWith('hp_test', JSON.stringify({ model: 'gpt-test' }), JSON.stringify({ requestId: 'req_diag' }));
    expect(nativeCalls.getStatus).toHaveBeenCalledWith('hp_test');
    expect(nativeCalls.markConcurrencyScopeBusy).toHaveBeenCalledWith('hp_test', 'primary.key1.gpt-test');
  });

  it('keeps HubPipeline native engine bridge owner names queryable by function map', async () => {
    const fs = await import('node:fs');
    const rustOwner = fs.readFileSync(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_engine/registry.rs',
      'utf8',
    );
    const bridgeSource = fs.readFileSync(
      'src/modules/llmswitch/bridge/routing-integrations.ts',
      'utf8',
    );

    expect(rustOwner).toContain('feature_id: hub.runtime_ingress_bridge');
    for (const ownerSymbol of [
      'create_hub_pipeline_engine_json',
      'hub_pipeline_execute_json',
      'dispose_hub_pipeline_engine_json',
      'update_hub_pipeline_virtual_router_config_json',
      'update_hub_pipeline_engine_deps_json',
      'hub_pipeline_virtual_router_route_json',
      'hub_pipeline_virtual_router_diagnose_route_json',
      'hub_pipeline_virtual_router_status_json',
      'hub_pipeline_virtual_router_mark_concurrency_scope_busy_json',
    ]) {
      expect(rustOwner).toContain(ownerSymbol);
    }
    for (const bridgeName of [
      'createHubPipelineNative',
      'executeHubPipelineNative',
      'updateHubPipelineVirtualRouterConfigNative',
      'updateHubPipelineEngineDepsNative',
      'routeHubPipelineVirtualRouterNative',
      'diagnoseHubPipelineVirtualRouterNative',
      'getHubPipelineVirtualRouterStatusNative',
      'markHubPipelineVirtualRouterConcurrencyScopeBusyNative',
    ]) {
      expect(bridgeSource).toContain(bridgeName);
    }
  });
});
