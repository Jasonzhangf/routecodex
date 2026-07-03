import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const executeHubPipelineWithNativeMock = jest.fn();
const normalizeProviderResponseEffectPlanWithNativeMock = jest.fn(() => ({
  runtimeStateWrite: {
    keepForSubmitToolOutputs: false
  },
  servertoolRuntimeActions: []
}));
const materializeProviderResponseSsePayloadWithNativeMock = jest.fn(async ({ payload }: { payload: unknown }) => payload);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js',
  () => ({
    executeHubPipelineWithNative: executeHubPipelineWithNativeMock,
    buildProviderResponseMetadataSnapshotWithNative: jest.fn(({
      hasBoundMetadataCenter,
      requestTruth,
      continuationContext,
      runtimeControl,
      directMetadataCenterSnapshot,
      nestedMetadataCenterSnapshot,
    }: {
      hasBoundMetadataCenter: boolean;
      requestTruth: Record<string, unknown>;
      continuationContext: Record<string, unknown>;
      runtimeControl: Record<string, unknown>;
      directMetadataCenterSnapshot?: Record<string, unknown> | null;
      nestedMetadataCenterSnapshot?: Record<string, unknown> | null;
    }) => ({
      metadataCenterSnapshot: hasBoundMetadataCenter
        ? { requestTruth, continuationContext, runtimeControl }
        : directMetadataCenterSnapshot ?? nestedMetadataCenterSnapshot ?? null
    })),
    normalizeProviderResponseEffectPlanWithNative: normalizeProviderResponseEffectPlanWithNativeMock,
    planProviderResponseServertoolRuntimeActionsWithNative: jest.fn(() => ({
      executionPlans: [],
    })),
    resolveProviderProtocolWithNative: jest.fn(({ metadataCenterSnapshot }: {
      metadataCenterSnapshot?: { runtimeControl?: Record<string, unknown> } | null;
    }) => ({
      providerProtocol: metadataCenterSnapshot?.runtimeControl?.providerProtocol
    })),
    projectMetadataWritePlanToRuntimeControlWithNative: jest.fn(({ plan }: {
      plan: Record<string, unknown>;
    }) => Object.fromEntries(
      Object.entries(plan).filter(([key, value]) => key !== 'learnedNote' && value !== null && value !== undefined)
    )),
    resolveProviderResponsePostServertoolEffectWithNative: jest.fn(({
      currentPayload,
      orchestrationPayload,
      orchestrationExecuted
    }: {
      currentPayload: Record<string, unknown>;
      orchestrationPayload: Record<string, unknown>;
      orchestrationExecuted: boolean;
    }) => ({
      payload: orchestrationExecuted ? orchestrationPayload : currentPayload,
      stage: orchestrationExecuted ? 'HubRespChatProcess03Governed' : 'unchanged',
      shouldProjectClientSemantic: false,
    })),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.js',
  () => ({
    buildProviderSseStreamReadErrorDescriptorWithNative: jest.fn(({ message }: { message: string }) => ({
      message,
      code: 'provider_response_sse_read_failed',
      upstreamCode: undefined,
      statusCode: 500,
      retryable: false,
      requestExecutorProviderErrorStage: 'provider_response_sse_read'
    })),
    materializeProviderResponseSsePayloadWithNative: materializeProviderResponseSsePayloadWithNativeMock,
    normalizeChatUsageWithNative: jest.fn((payload: unknown) => payload),
    normalizeResponsesToolCallArgumentsForClientWithNative: jest.fn((payload: unknown) => payload),
    parseRespFormatEnvelopeWithNative: jest.fn((payload: unknown) => payload),
    projectPostServertoolHubRespOutbound04ClientSemanticWithNative: jest.fn(({ payload }: { payload: unknown }) => payload)
    ,
    resolveProviderResponseContextHelpersWithNative: jest.fn(({ context, entryEndpoint }: { context: Record<string, unknown>; entryEndpoint?: string }) => ({
      isServerToolFollowup: false,
      toolSurfaceShadowEnabled: false,
      clientProtocol: entryEndpoint === '/v1/responses' ? 'openai-responses' : 'openai-chat',
      clientFacingRequestId: typeof context.requestId === 'string' ? context.requestId : 'req-test'
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js',
  () => ({
    captureResponsesRequestContext: jest.fn(),
    finalizeResponsesConversationRequestRetention: jest.fn(),
    recordResponsesResponse: jest.fn(),
    responsesConversationStore: {
      getDebugStats: jest.fn(() => ({})),
    },
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-session-usage.js',
  () => ({
    saveChatProcessSessionActualUsage: jest.fn(),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js',
  () => ({
    runServertoolResponseStageOrchestrationShell: jest.fn(async ({ payload }: { payload: unknown }) => ({
      executed: false,
      payload,
    })),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    readRuntimeMetadata: jest.fn(() => ({})),
    ensureRuntimeMetadata: jest.fn((carrier: Record<string, unknown>) => {
      const existing = carrier.__rt;
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return existing;
      }
      carrier.__rt = {};
      return carrier.__rt as Record<string, unknown>;
    }),
  })
);

const { convertProviderResponse } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js'
);
const { recordResponsesResponse } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js'
);

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/provider-response.metadata-center-provider-protocol.spec.ts',
  symbol: 'bindProviderProtocol',
  stage: 'test_runtime_control_provider_protocol'
} as const;

describe('provider response metadata center providerProtocol contract', () => {
  beforeEach(() => {
    executeHubPipelineWithNativeMock.mockReset();
    normalizeProviderResponseEffectPlanWithNativeMock.mockClear();
    materializeProviderResponseSsePayloadWithNativeMock.mockClear();
    recordResponsesResponse.mockClear();
    executeHubPipelineWithNativeMock.mockReturnValue({
      success: true,
      payload: {
        id: 'chatcmpl_provider_response_center_protocol',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'center protocol wins' },
          finish_reason: 'stop'
        }]
      },
      effectPlan: {
        effects: [{
          kind: 'runtimeStateWrite',
          payload: {
            requestId: 'req_provider_response_center_protocol',
            clientProtocol: 'openai-chat',
            payload: {
              id: 'chatcmpl_provider_response_center_protocol',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: 'center protocol wins' },
                finish_reason: 'stop'
              }]
            },
            keepForSubmitToolOutputs: false
          }
        }]
      },
      diagnostics: []
    });
  });

  it('prefers bound MetadataCenter runtimeControl.providerProtocol over external providerProtocol option', async () => {
    const context: Record<string, unknown> = {
      requestId: 'openai-responses-provider-20260628T184855563-416867-1902',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId: 'provider-response-metadata-center-provider-protocol-session'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', 'openai-responses-router-20260628T184855563-416867-1902', TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('sessionId', context.sessionId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl(
      'providerProtocol',
      'anthropic-messages',
      TEST_METADATA_WRITER,
      'test-provider-protocol'
    );

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'msg_provider_response_center_protocol',
        type: 'message',
        role: 'assistant',
        model: 'mimo-v2.5',
        content: [{ type: 'text', text: 'center protocol wins' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(materializeProviderResponseSsePayloadWithNativeMock).toHaveBeenCalled();
    expect(executeHubPipelineWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        providerProtocol: 'anthropic-messages',
      })
    }));
    expect(recordResponsesResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'openai-responses-provider-20260628T184855563-416867-1902'
    }));
    expect(result.body?.choices?.[0]?.message?.content).toBe('center protocol wins');
  });

  it('fails fast when Rust returns a malformed provider response effect plan', async () => {
    executeHubPipelineWithNativeMock.mockReturnValueOnce({
      success: true,
      payload: {
        id: 'chatcmpl_provider_response_malformed_effect_plan',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      effectPlan: {
        effects: null
      },
      diagnostics: []
    });
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_malformed_effect_plan',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'openai-chat', TEST_METADATA_WRITER, 'test-provider-protocol');

    await expect(convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_provider_response_malformed_effect_plan',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false
    })).rejects.toThrow('Rust HubPipeline response path returned malformed effect plan');
    expect(normalizeProviderResponseEffectPlanWithNativeMock).not.toHaveBeenCalled();
  });

  it('fails fast when Rust returns malformed provider response servertool runtime actions', async () => {
    normalizeProviderResponseEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: null
    });
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_malformed_servertool_actions',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'openai-chat', TEST_METADATA_WRITER, 'test-provider-protocol');

    await expect(convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_provider_response_malformed_servertool_actions',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false
    })).rejects.toThrow('Rust HubPipeline response path returned malformed servertool runtime actions');
  });

  it('fails fast when Rust returns malformed provider response stream pipe effect', async () => {
    normalizeProviderResponseEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: [],
      streamPipe: {
        codec: 'openai-chat',
        requestId: 'req_provider_response_malformed_stream_pipe'
      }
    });
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_malformed_stream_pipe',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'openai-chat', TEST_METADATA_WRITER, 'test-provider-protocol');

    await expect(convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_provider_response_malformed_stream_pipe',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: true
    })).rejects.toThrow('Rust HubPipeline response path returned malformed stream pipe effect');
  });
});
