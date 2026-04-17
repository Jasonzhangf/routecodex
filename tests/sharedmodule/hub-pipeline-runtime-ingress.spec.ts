import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const hookCalls: Array<{ owner: unknown; hooks?: { handleProviderError?: (event: unknown) => void; handleProviderSuccess?: (event: unknown) => void } }> = [];
const setVirtualRouterPolicyRuntimeRouterHooks = jest.fn((owner: unknown, hooks?: { handleProviderError?: (event: unknown) => void; handleProviderSuccess?: (event: unknown) => void }) => {
  hookCalls.push({ owner, hooks });
});
const setHubPolicyRuntimePolicy = jest.fn();

const engineInstances: Array<{
  initialize: jest.Mock;
  updateDeps: jest.Mock;
  handleProviderError: jest.Mock;
  handleProviderSuccess: jest.Mock;
}> = [];

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js', () => ({
  VirtualRouterEngine: class VirtualRouterEngineMock {
    public initialize = jest.fn();
    public updateDeps = jest.fn();
    public handleProviderError = jest.fn();
    public handleProviderSuccess = jest.fn();

    constructor(_deps?: unknown) {
      engineInstances.push(this as any);
    }
  }
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.js', () => ({
  setVirtualRouterPolicyRuntimeRouterHooks
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/hub/policy/policy-engine.js', async () => {
  return {
    applyHubProviderOutboundPolicy: jest.fn((value: unknown) => value),
    recordHubPolicyObservation: jest.fn(),
    setHubPolicyRuntimePolicy
  };
});

const { HubPipeline } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js');

describe('HubPipeline runtime ingress wiring', () => {
  beforeEach(() => {
    hookCalls.length = 0;
    engineInstances.length = 0;
    setVirtualRouterPolicyRuntimeRouterHooks.mockClear();
    setHubPolicyRuntimePolicy.mockClear();
  });

  it('registers router runtime hooks via provider-runtime-ingress and unregisters on dispose', () => {
    const pipeline = new HubPipeline({
      virtualRouter: {} as any
    });

    expect(setHubPolicyRuntimePolicy).toHaveBeenCalledTimes(1);
    expect(engineInstances).toHaveLength(1);
    expect(setVirtualRouterPolicyRuntimeRouterHooks).toHaveBeenNthCalledWith(
      1,
      pipeline,
      expect.objectContaining({
        handleProviderError: expect.any(Function),
        handleProviderSuccess: expect.any(Function)
      })
    );

    const hooks = hookCalls[0]?.hooks;
    const providerError = { code: 'HTTP_429' };
    const providerSuccess = { runtime: { requestId: 'req_1' } };
    hooks?.handleProviderError?.(providerError);
    hooks?.handleProviderSuccess?.(providerSuccess);

    expect(engineInstances[0]!.handleProviderError).toHaveBeenCalledWith(providerError);
    expect(engineInstances[0]!.handleProviderSuccess).toHaveBeenCalledWith(providerSuccess);

    pipeline.dispose();

    expect(setVirtualRouterPolicyRuntimeRouterHooks).toHaveBeenNthCalledWith(2, pipeline, undefined);
  });
});
