import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// Mock the native binding loader so we can control which functions exist
const nativeBindings: Record<string, unknown> = {};
jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath.js',
  () => ({
    loadNativeRouterHotpathBindingForInternalUse: () => nativeBindings,
  })
);

// Mock native router hotpath policy
jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-policy.js',
  () => ({
    isNativeDisabledByEnv: () => false,
    failNativeRequired: () => { throw new Error('native disabled'); },
  })
);

// Mock common utils
jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/shared/common-utils.js',
  () => ({
    formatUnknownError: (e: unknown) => String(e),
  })
);

const {
  executeHubPipelineWithNative,
  runHubPipelineOrchestrationWithNative,
  runHubPipelineLibWithNative,
} = await import(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js'
);

describe('HubPipeline Rust Lib API contract', () => {
  beforeEach(() => {
    Object.keys(nativeBindings).forEach(k => delete nativeBindings[k]);
  });

  it('runHubPipelineLibWithNative exists and calls runHubPipelineLibJson', () => {
    nativeBindings['runHubPipelineLibJson'] = (input: string) => JSON.stringify({
      requestId: 'req-1',
      success: true,
      payload: { model: 'gpt-5.5', messages: [] },
      metadata: {},
      effectPlan: { effects: [] },
      diagnostics: [],
    });

    const result = runHubPipelineLibWithNative({
      request: {
        requestId: 'req-1',
        endpoint: '/v1/chat/completions',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        payload: { model: 'gpt-5.5', messages: [] },
        metadata: {},
        stream: false,
        processMode: 'chat',
        direction: 'request',
        stage: 'inbound',
      },
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toBe('req-1');
  });

  it('orchestration semantics protocol exports the Rust lib entry', async () => {
    const { runHubPipelineLibWithNative: fromLib } = await import(
      '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js'
    ).catch(() => ({ runHubPipelineLibWithNative: undefined }));
    expect(fromLib).toBeDefined();
  });
});
