import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('llmswitch bridge routing-integrations native error projection', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('throws native HubPipeline Error payload directly instead of wrapping it as invalid JSON', async () => {
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
      getRouterHotpathJsonBindingSync: () => ({
        hubPipelineExecuteJson: jest.fn(() => (
          'Error: hub_pipeline_missing_provider_protocol: HubPipeline requires metadata center runtime_control.providerProtocol'
        )),
      }),
    }));

    const routing = await import('../../../../src/modules/llmswitch/bridge/routing-integrations.js');

    expect(() => routing.executeHubPipelineNative('hp_missing_protocol', { id: 'req_1' })).toThrow(
      'hub_pipeline_missing_provider_protocol: HubPipeline requires metadata center runtime_control.providerProtocol',
    );
    expect(() => routing.executeHubPipelineNative('hp_missing_protocol', { id: 'req_1' })).not.toThrow(
      /returned invalid payload/,
    );
  });

  it('throws native virtual-router Error payload directly instead of wrapping it as invalid JSON', async () => {
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', () => ({
      getRouterHotpathJsonBindingSync: () => ({
        resolveRccUserDirJson: jest.fn(() => 'null'),
        planVirtualRouterRouteHostEffectsJson: jest.fn(() => '{}'),
        finalizeVirtualRouterRouteHostEffectsJson: jest.fn(() => 'null'),
        buildVirtualRouterRuntimeMetadataJson: jest.fn(() => '{}'),
        hubPipelineVirtualRouterRouteJson: jest.fn(() => (
          'Error: hub_pipeline_virtual_router_route failed: PROVIDER_NOT_AVAILABLE'
        )),
      }),
    }));

    const routing = await import('../../../../src/modules/llmswitch/bridge/routing-integrations.js');

    expect(() => routing.routeHubPipelineVirtualRouterNative('hp_no_provider', { model: 'gpt-5.5' }, {})).toThrow(
      'hub_pipeline_virtual_router_route failed: PROVIDER_NOT_AVAILABLE',
    );
    expect(() => routing.routeHubPipelineVirtualRouterNative('hp_no_provider', { model: 'gpt-5.5' }, {})).not.toThrow(
      /returned invalid payload/,
    );
  });
});
