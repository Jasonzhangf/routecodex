import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const executeHubPipelineWithNativeMock = jest.fn();
const normalizeProviderResponseEffectPlanWithNativeMock = jest.fn(() => ({
  runtimeStateWrite: {
    keepForSubmitToolOutputs: false
  },
  servertoolRuntimeActions: []
}));
const materializeProviderResponseSsePayloadWithNativeMock = jest.fn(async ({ payload }: { payload: unknown }) => payload);
const planChatProcessSessionUsageMock = jest.fn();
const buildSseFramesFromJsonWithNativeMock = jest.fn(() => ({
  frames: ['event: response.completed\ndata: {"type":"response.completed"}\n\n'],
  stats: { protocol: 'openai-responses' }
}));

jest.unstable_mockModule(
  '../../src/modules/llmswitch/bridge/native-exports.js',
  () => ({
    getRouterHotpathJsonBindingSync: () => ({
      executeHubPipelineJson: (inputJson: string) => JSON.stringify(executeHubPipelineWithNativeMock(JSON.parse(inputJson))),
      buildProviderResponseMetadataSnapshotJson: (inputJson: string) => {
        const {
      hasBoundMetadataCenter,
      requestTruth,
      continuationContext,
      runtimeControl,
      directMetadataCenterSnapshot,
      nestedMetadataCenterSnapshot,
        } = JSON.parse(inputJson) as {
      hasBoundMetadataCenter: boolean;
      requestTruth: Record<string, unknown>;
      continuationContext: Record<string, unknown>;
      runtimeControl: Record<string, unknown>;
      directMetadataCenterSnapshot?: Record<string, unknown> | null;
      nestedMetadataCenterSnapshot?: Record<string, unknown> | null;
        };
        return JSON.stringify({
      metadataCenterSnapshot: hasBoundMetadataCenter
        ? { requestTruth, continuationContext, runtimeControl }
        : directMetadataCenterSnapshot ?? nestedMetadataCenterSnapshot ?? null
        });
      },
      normalizeProviderResponseEffectPlanJson: (inputJson: string) => JSON.stringify(
        normalizeProviderResponseEffectPlanWithNativeMock(JSON.parse(inputJson))
      ),
      resolveProviderProtocolJson: (inputJson: string) => {
        const input = JSON.parse(inputJson) as { metadataCenterSnapshot?: { runtimeControl?: Record<string, unknown> } | null };
        return JSON.stringify({ providerProtocol: input.metadataCenterSnapshot?.runtimeControl?.providerProtocol });
      },
      publishResponsesRecordPlanJson: (
        requestId: string,
        responseJson: string,
        contextJson: string,
        runtimeStateWriteJson: string,
        entryEndpoint: string
      ) => JSON.stringify({
        recordArgs: {
          requestId,
          response: JSON.parse(responseJson),
          ...(JSON.parse(contextJson).sessionId ? { sessionId: JSON.parse(contextJson).sessionId } : {}),
        },
        finalizeArgs: { requestId, keepForSubmitToolOutputs: false },
        usageArgs: { usage: JSON.parse(runtimeStateWriteJson)?.usage },
        entryEndpoint,
      }),
      ensureRuntimeMetadataJson: (inputJson: string) => {
        const carrier = JSON.parse(inputJson);
        if (!carrier.__rt || typeof carrier.__rt !== 'object' || Array.isArray(carrier.__rt)) carrier.__rt = {};
        return JSON.stringify(carrier);
      },
      buildProviderSseStreamReadErrorDescriptorJson: (inputJson: string) => {
        const { message } = JSON.parse(inputJson) as { message: string };
        return JSON.stringify({
      message,
      code: 'provider_response_sse_read_failed',
      upstreamCode: undefined,
      statusCode: 500,
      retryable: false,
      requestExecutorProviderErrorStage: 'provider_response_sse_read'
        });
      },
      materializeProviderResponseSsePayloadJson: (inputJson: string) => JSON.stringify(
        materializeProviderResponseSsePayloadWithNativeMock(JSON.parse(inputJson))
      ),
      resolveProviderResponseContextHelpersJson: (
        contextJson: string,
        _legacyFollowupMarkerJson: string,
        entryEndpointJson: string
      ) => {
        const context = JSON.parse(contextJson) as Record<string, unknown>;
        const entryEndpoint = JSON.parse(entryEndpointJson) as string | null;
        return JSON.stringify({
      isServerToolFollowup: false,
      toolSurfaceShadowEnabled: false,
      clientProtocol: entryEndpoint === '/v1/responses' ? 'openai-responses' : 'openai-chat',
      clientFacingRequestId: typeof context.requestId === 'string' ? context.requestId : 'req-test'
        });
      },
      planChatProcessSessionUsageJson: (inputJson: string) => JSON.stringify(
        planChatProcessSessionUsageMock(JSON.parse(inputJson)) ?? null
      ),
      buildSseFramesFromJsonJson: (inputJson: string) => {
        const input = JSON.parse(inputJson) as {
          protocol: string;
          response: unknown;
          request_id?: string;
          model?: string;
        };
        return JSON.stringify(buildSseFramesFromJsonWithNativeMock({
          protocol: input.protocol,
          response: input.response,
          requestId: input.request_id,
          model: input.model,
        }));
      },
      projectMetadataWritePlanToRuntimeControlWritePlanJson: (inputJson: string) => {
        const { plan } = JSON.parse(inputJson) as { plan: Record<string, unknown> };
        const runtimeControl = Object.fromEntries(
          Object.entries(plan).filter(([key, value]) => key !== 'learnedNote' && value !== null && value !== undefined)
        );
        return JSON.stringify({
          runtimeControl: Object.keys(runtimeControl).length > 0 ? runtimeControl : null
        });
      },
    }),
  })
);

jest.unstable_mockModule(
  '../../src/modules/llmswitch/bridge/responses-conversation-store-host.js',
  () => ({
    captureResponsesRequestContext: jest.fn(),
    finalizeResponsesConversationRequestRetention: jest.fn(),
    recordResponsesResponse: jest.fn(),
    getResponsesConversationStoreDebugStats: jest.fn(() => ({})),
  })
);

const { convertProviderResponse } = await import(
  '../../src/modules/llmswitch/bridge/provider-response-converter-host.js'
);
const { recordResponsesResponse } = await import(
  '../../src/modules/llmswitch/bridge/responses-conversation-store-host.js'
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
    planChatProcessSessionUsageMock.mockClear();
    buildSseFramesFromJsonWithNativeMock.mockClear();
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

  it('fails fast when Rust returns retired provider response servertool runtime actions', async () => {
    normalizeProviderResponseEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: [{
        action: 'requireResponseHookRuntime',
        stopGateway: {
          observed: true,
          eligible: true,
          source: 'responses',
          reason: 'status_completed'
        },
        payload: {
          id: 'chatcmpl_provider_response_retired_servertool_runtime_action',
          object: 'chat.completion',
          choices: []
        }
      }]
    });
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_retired_servertool_runtime_action',
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
        id: 'chatcmpl_provider_response_retired_servertool_runtime_action',
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
    })).rejects.toThrow('server-side tool execution has been removed and CLI-owned tools must be projected by Rust');
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

  it('uses request truth id, not streamPipe-local id, when encoding Responses SSE frames', async () => {
    normalizeProviderResponseEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: [],
      streamPipe: {
        codec: 'openai-responses',
        requestId: 'stale_stream_pipe_request_id',
        payload: {
          id: 'resp_provider_response_sse_request_id',
          object: 'response',
          status: 'completed',
          model: 'gpt-test',
          output: [],
        }
      }
    });
    const context: Record<string, unknown> = {
      requestId: 'openai-responses-router-gpt-5.5-20260704T082457252-457519-3916',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'openai-chat', TEST_METADATA_WRITER, 'test-provider-protocol');

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_provider_response_sse_request_id',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: true
    });

    expect(result.sseStream).toBeDefined();
    expect(buildSseFramesFromJsonWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai-responses',
      requestId: 'openai-responses-router-gpt-5.5-20260704T082457252-457519-3916',
      response: expect.objectContaining({
        id: 'resp_provider_response_sse_request_id'
      })
    }));
    expect(buildSseFramesFromJsonWithNativeMock).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stale_stream_pipe_request_id'
    }));
  });
});
