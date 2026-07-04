import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const nativeBindings: Record<string, unknown> = {};

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.js',
  () => ({
    loadNativeRouterHotpathBindingForInternalUse: () => nativeBindings,
  })
);

const { resolveHubPipelineRequestProviderProtocolWithNative } = await import(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js'
);

describe('native HubPipeline providerProtocol wrapper error projection', () => {
  beforeEach(() => {
    for (const key of Object.keys(nativeBindings)) {
      delete nativeBindings[key];
    }
  });

  it('RED-GREEN: preserves native Error message instead of reporting non-string result', () => {
    nativeBindings.resolveHubPipelineRequestProviderProtocolJson = () =>
      new Error('HubPipeline requires metadata center runtime_control.providerProtocol');

    expect(() => resolveHubPipelineRequestProviderProtocolWithNative({
      runtimeControl: null,
    })).toThrow('HubPipeline requires metadata center runtime_control.providerProtocol');
    expect(() => resolveHubPipelineRequestProviderProtocolWithNative({
      runtimeControl: null,
    })).not.toThrow('non-string result');
  });
});
