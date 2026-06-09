import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const engineInstances: Array<{
  initialize: jest.Mock;
  updateDeps: jest.Mock;
  handleProviderError: jest.Mock;
  handleProviderSuccess: jest.Mock;
  registerProviderRuntimeIngress: jest.Mock;
  unregisterProviderRuntimeIngress: jest.Mock;
}> = [];

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js', () => ({
  createVirtualRouterRuntime: () => {
    const engine = {
      initialize: jest.fn(),
      updateDeps: jest.fn(),
      handleProviderError: jest.fn(),
      handleProviderSuccess: jest.fn(),
      registerProviderRuntimeIngress: jest.fn(),
      unregisterProviderRuntimeIngress: jest.fn(),
    };
    engineInstances.push(engine);
    return engine;
  },
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-engine-proxy.js', () => ({
  VirtualRouterEngineProxy: class VirtualRouterEngineMock {
    public initialize = jest.fn();
    public updateDeps = jest.fn();
    public handleProviderError = jest.fn();
    public handleProviderSuccess = jest.fn();
    public registerProviderRuntimeIngress = jest.fn();
    public unregisterProviderRuntimeIngress = jest.fn();

    constructor(_deps?: unknown) {
      engineInstances.push(this as any);
    }
  }
}));

const { HubPipeline } = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js');

describe('HubPipeline runtime ingress wiring', () => {
  beforeEach(() => {
    engineInstances.length = 0;
  });

  it('registers native router runtime ingress and unregisters on dispose', () => {
    const pipeline = new HubPipeline({
      virtualRouter: {} as any
    });

    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0]!.registerProviderRuntimeIngress).toHaveBeenCalledTimes(1);

    pipeline.dispose();

    expect(engineInstances[0]!.unregisterProviderRuntimeIngress).toHaveBeenCalledTimes(1);
  });

  it('fails fast when native router runtime deps update fails', () => {
    const pipeline = new HubPipeline({
      virtualRouter: {} as any
    });
    engineInstances[0]!.updateDeps.mockImplementationOnce(() => {
      throw new Error('native deps rejected');
    });

    expect(() => pipeline.updateRuntimeDeps({ healthStore: null })).toThrow('native deps rejected');
  });
});
