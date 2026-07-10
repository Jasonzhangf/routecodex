import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// Mock the native binding loader so we can control which functions exist
const nativeBindings: Record<string, unknown> = {};
jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js',
  () => ({
    isNativeDisabledByEnv: () => false,
    loadNativeRouterHotpathBindingForInternalUse: () => nativeBindings,
    failNativeRequired: (_capability: string, reason?: string) => {
      throw new Error(reason ? `native required: ${reason}` : 'native required');
    },
    stringifyNativePayloadForError: (value: unknown) =>
      value instanceof Error ? value.message : String(value ?? ''),
  })
);

const {
  executeHubPipelineWithNative,
  runHubPipelineOrchestrationWithNative,
  runHubPipelineLibWithNative,
} = await import(
  './helpers/hub-pipeline-orchestration-direct-native.js'
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
      './helpers/hub-pipeline-orchestration-direct-native.js'
    ).catch(() => ({ runHubPipelineLibWithNative: undefined }));
    expect(fromLib).toBeDefined();
  });

  it('preserves native Error object messages instead of reporting empty result', () => {
    nativeBindings['executeHubPipelineJson'] = () => new Error(
      'hub_pipeline_virtual_router_facade_init_failed: routing configuration missing'
    );

    expect(() => executeHubPipelineWithNative({
      request: {
        requestId: 'req-native-error-object',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        payload: { id: 'resp-native-error-object', output: [] },
        metadata: {},
        stream: false,
        processMode: 'chat',
        direction: 'response',
        stage: 'outbound',
      },
    })).toThrow('routing configuration missing');
  });
});
