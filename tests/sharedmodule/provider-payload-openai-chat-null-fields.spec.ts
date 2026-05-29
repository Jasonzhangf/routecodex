import { jest } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/policy/policy-engine.js',
  () => ({
    applyHubProviderOutboundPolicy: ({ payload }: { payload: Record<string, unknown> }) => payload,
    recordHubPolicyObservation: () => undefined
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/tool-surface/tool-surface-engine.js',
  () => ({
    applyProviderOutboundToolSurface: ({ payload }: { payload: Record<string, unknown> }) => payload
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({ readRuntimeMetadata: () => undefined })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({ applyDirectBuiltinWebSearchToolWithNative: (payload: Record<string, unknown>) => payload })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js',
  () => ({
    stripPrivateFieldsWithNative: (payload: Record<string, unknown>) => {
      const next = { ...payload };
      if (next.reasoning === null) {
        delete next.reasoning;
      }
      return next;
    }
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-shared-conversion-semantics.js',
  () => ({ stripInternalToolingMetadataWithNative: (metadata: Record<string, unknown>) => metadata })
);

const { finalizeProviderPayloadWithPolicy } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-policy-apply-blocks.js'
);

describe('openai-chat provider payload null optional fields', () => {
  it('RED: strips null reasoning for compat passthrough OpenAI-compatible chat providers', () => {
    const output = finalizeProviderPayloadWithPolicy({
      effectivePolicy: undefined,
      outboundProtocol: 'openai-chat',
      compatibilityProfile: 'compat:passthrough',
      formattedPayload: {
        model: 'deepseek-v4-flash-free',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [
          {
            type: 'function',
            function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
          }
        ],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: null,
        max_tokens: 8192
      } as any,
      stageRecorder: undefined,
      requestId: 'req_openai_chat_null_fields',
      config: { virtualRouter: {} } as any,
      outboundAdapterContext: {}
    });

    expect(Object.prototype.hasOwnProperty.call(output, 'reasoning')).toBe(false);
    expect(output.parallel_tool_calls).toBe(false);
    expect(output.tool_choice).toBe('auto');
  });
});
