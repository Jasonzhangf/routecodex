import { describe, expect, it } from '@jest/globals';

const routing = await import('../../../../src/modules/llmswitch/bridge/routing-integrations.js');

describe('llmswitch bridge routing-integrations native handle surface', () => {
  it('does not expose deleted HubPipeline constructor bridge APIs', () => {
    expect(('getHubPipeline' + 'Ctor') in routing).toBe(false);
    expect(('getHubPipeline' + 'CtorForImpl') in routing).toBe(false);
  });

  it('exposes native handle-mode HubPipeline entry points', () => {
    expect(typeof routing.createHubPipelineNative).toBe('function');
    expect(typeof routing.executeHubPipelineNative).toBe('function');
    expect(typeof routing.updateHubPipelineVirtualRouterConfigNative).toBe('function');
    expect(typeof routing.updateHubPipelineEngineDepsNative).toBe('function');
    expect(typeof routing.routeHubPipelineVirtualRouterNative).toBe('function');
    expect(typeof routing.diagnoseHubPipelineVirtualRouterNative).toBe('function');
    expect(typeof routing.getHubPipelineVirtualRouterStatusNative).toBe('function');
    expect(typeof routing.markHubPipelineVirtualRouterConcurrencyScopeBusyNative).toBe('function');
    expect(typeof routing.disposeHubPipelineNative).toBe('function');
  });
});
