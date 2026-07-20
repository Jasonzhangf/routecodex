import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('llmswitch bridge routing-integrations native error projection', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('throws native HubPipeline Error payload directly instead of wrapping it as invalid JSON', async () => {
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-native-host.js', () => ({
      buildRequestStageRuntimeControlWritePlanNative: jest.fn(),
      getRouterHotpathJsonBindingSync: () => ({
        hubPipelineExecuteJson: jest.fn(() => (
          'Error: hub_pipeline_missing_provider_protocol: HubPipeline requires metadata center runtime_control.providerProtocol'
        )),
      }),
      resolveEntryProtocolFromEndpointNative: jest.fn(),
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
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-native-host.js', () => ({
      buildRequestStageRuntimeControlWritePlanNative: jest.fn(),
      getRouterHotpathJsonBindingSync: () => ({
        resolveRccUserDirJson: jest.fn(() => 'null'),
        planVirtualRouterRouteHostEffectsJson: jest.fn(() => '{}'),
        finalizeVirtualRouterRouteHostEffectsJson: jest.fn(() => 'null'),
        buildVirtualRouterRuntimeMetadataJson: jest.fn(() => '{}'),
        hubPipelineVirtualRouterRouteJson: jest.fn(() => (
          'Error: hub_pipeline_virtual_router_route failed: PROVIDER_NOT_AVAILABLE'
        )),
      }),
      resolveEntryProtocolFromEndpointNative: jest.fn(),
    }));

    const routing = await import('../../../../src/modules/llmswitch/bridge/routing-integrations.js');

    expect(() => routing.routeHubPipelineVirtualRouterNative('hp_no_provider', { model: 'gpt-5.5' }, {})).toThrow(
      'hub_pipeline_virtual_router_route failed: PROVIDER_NOT_AVAILABLE',
    );
    expect(() => routing.routeHubPipelineVirtualRouterNative('hp_no_provider', { model: 'gpt-5.5' }, {})).not.toThrow(
      /returned invalid payload/,
    );
  });

  it('preserves virtual-router HTTP_429 details on the thrown Error carrier', async () => {
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-native-host.js', () => ({
      buildRequestStageRuntimeControlWritePlanNative: jest.fn(),
      getRouterHotpathJsonBindingSync: () => ({
        resolveRccUserDirJson: jest.fn(() => 'null'),
        planVirtualRouterRouteHostEffectsJson: jest.fn(() => '{}'),
        finalizeVirtualRouterRouteHostEffectsJson: jest.fn(() => 'null'),
        buildVirtualRouterRuntimeMetadataJson: jest.fn(() => '{}'),
        hubPipelineVirtualRouterRouteJson: jest.fn(() => (
          'Error: hub_pipeline_virtual_router_facade_route_failed: Rust HubPipeline virtual router facade route failed: VIRTUAL_ROUTER_ERROR:HTTP_429:{"details":{"statusCode":429,"retryAfterMs":1247778,"primaryExhaustedRouteName":"multimodal","primaryExhaustedTargets":["fwd.free.gpt-5.5","fwd.paid.gpt-5.5"]},"message":"Route providers are temporarily unavailable; retry after 1247778ms"}'
        )),
      }),
      resolveEntryProtocolFromEndpointNative: jest.fn(),
    }));

    const routing = await import('../../../../src/modules/llmswitch/bridge/routing-integrations.js');
    const coreUtils = await import('../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js');

    let caught: unknown;
    try {
      routing.routeHubPipelineVirtualRouterNative('hp_rate_limited', { model: 'gpt-5.5' }, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Record<string, unknown>).code).toBe('HTTP_429');
    expect((caught as Record<string, unknown>).statusCode).toBe(429);
    expect((caught as Record<string, unknown>).details).toEqual({
      statusCode: 429,
      retryAfterMs: 1247778,
      primaryExhaustedRouteName: 'multimodal',
      primaryExhaustedTargets: ['fwd.free.gpt-5.5', 'fwd.paid.gpt-5.5'],
    });
    expect(coreUtils.isPoolExhaustedPipelineError(caught)).toBe(true);
    expect(coreUtils.resolvePrimaryExhaustedRoutingContextFromError(caught)).toEqual({
      route: 'multimodal',
      exhaustedTargets: ['fwd.free.gpt-5.5', 'fwd.paid.gpt-5.5'],
    });
  });
});
