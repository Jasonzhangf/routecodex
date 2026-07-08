import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

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

jest.unstable_mockModule(
  '../../src/modules/llmswitch/bridge/native-exports.js',
  () => ({
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
    }),
  }),
);

const { NativeHubPipelineTestWrapper: HubPipeline } = await import('../helpers/native-hub-pipeline-test-wrapper.js');

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/hub-pipeline.metadata-center-provider-protocol.spec.ts',
  symbol: 'bindRouteHint',
  stage: 'test_runtime_control_route_hint'
} as const;

describe('HubPipeline metadata center request-route contract', () => {
  beforeEach(() => {
    for (const call of Object.values(nativeCalls)) {
      call.mockReset();
    }
    nativeCalls.create.mockReturnValue(JSON.stringify({ handle: 'hp_metadata_center_test' }));
    nativeCalls.execute.mockReturnValue(JSON.stringify({ requestId: 'req_1', success: true, metadata: {}, nodeResults: [] }));
  });

  it('keeps bound MetadataCenter private unless server layer supplies a transport snapshot', async () => {
    const metadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      direction: 'request',
      stage: 'inbound'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'routeHint',
      'thinking',
      TEST_METADATA_WRITER,
      'test-route-hint'
    );

    const pipeline = new HubPipeline({ virtualRouter: {} as any });

    try {
      await pipeline.execute({
        id: 'req-metadata-center-route-before-provider-protocol',
        endpoint: '/v1/responses',
        payload: {
          model: 'gpt-test',
          input: 'hi'
        },
        metadata
      } as any);

      const nativeRequest = JSON.parse(nativeCalls.execute.mock.calls[0]![1]);
      expect(nativeRequest).toMatchObject({
        metadata: {
          entryEndpoint: '/v1/responses',
          direction: 'request',
          stage: 'inbound',
        },
      });
      expect(nativeRequest.metadata.__metadataCenter).toBeUndefined();
      expect(nativeRequest.metadata.metadataCenterSnapshot).toBeUndefined();
    } finally {
      pipeline.dispose();
    }
  });
});
