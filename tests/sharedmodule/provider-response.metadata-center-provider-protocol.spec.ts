import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const executeHubPipelineWithNativeMock = jest.fn();
const materializeProviderResponseOutboundEffectPlanWithNativeMock = jest.fn(() => ({
  runtimeStateWrite: {
    keepForSubmitToolOutputs: false
  },
  servertoolRuntimeActions: [],
}));
const planProviderResponseServertoolRetirementEffectMock = jest.fn(
  ({ servertoolRuntimeActions }: { servertoolRuntimeActions: unknown }) => {
    if (!Array.isArray(servertoolRuntimeActions)) {
      throw new Error('Rust HubPipeline response path returned malformed servertool runtime actions');
    }
    if (servertoolRuntimeActions.length === 0) return { action: 'continue' };
    const firstAction = servertoolRuntimeActions.find(
      (value) => value && typeof value === 'object' && !Array.isArray(value)
    ) as Record<string, unknown> | undefined;
    const stopGateway = firstAction?.stopGateway;
    return {
      action: 'reject_legacy_actions',
      stopGatewayWrite: stopGateway && typeof stopGateway === 'object' && !Array.isArray(stopGateway)
        ? {
            stopGatewayContext: stopGateway,
            writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
            reason: 'rust stop gateway control signal',
          }
        : null,
      errorMessage: 'Rust HubPipeline returned unsupported servertool runtime actions; server-side tool execution has been removed and CLI-owned tools must be projected by Rust',
    };
  }
);
const materializeProviderResponseSsePayloadWithNativeMock = jest.fn(async ({ payload }: { payload: unknown }) => payload);
const planChatProcessSessionUsageMock = jest.fn();
const buildSseFramesFromJsonWithNativeMock = jest.fn(() => ({
  frames: ['event: response.completed\ndata: {"type":"response.completed"}\n\n'],
  stats: { protocol: 'openai-responses' }
}));
const unusedProviderResponseNativeExportMock = jest.fn(() => {
  throw new Error('provider response native export was not expected in this test');
});

jest.unstable_mockModule(
  '../../src/modules/llmswitch/bridge/provider-response-native-host.js',
  () => ({
    detectRetryableEmptyAssistantResponseNative: unusedProviderResponseNativeExportMock,
    hasRequestedToolsInSemanticsNative: unusedProviderResponseNativeExportMock,
    isProviderNativeResumeContinuationNative: unusedProviderResponseNativeExportMock,
    isRequiredToolCallTurnNative: unusedProviderResponseNativeExportMock,
    isToolCallContinuationResponseNative: unusedProviderResponseNativeExportMock,
    isToolResultFollowupTurnNative: unusedProviderResponseNativeExportMock,
    resolveProviderResponseRequestSemanticsNative: unusedProviderResponseNativeExportMock,
    getProviderResponseNativeBindingSync: () => ({
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
      materializeProviderResponseOutboundEffectPlanJson: (inputJson: string) => {
        const nativePlan = JSON.parse(inputJson) as Record<string, unknown>;
        if (!nativePlan.payload || typeof nativePlan.payload !== 'object' || Array.isArray(nativePlan.payload)) {
          throw new Error('Rust HubPipeline response outbound effect materializer missing payload');
        }
        if (typeof nativePlan.requestId !== 'string' || !nativePlan.requestId.trim()) {
          throw new Error('Rust HubPipeline response outbound effect materializer missing requestId');
        }
        if (!Array.isArray(nativePlan.diagnostics)) {
          throw new Error('Rust HubPipeline response outbound effect materializer missing diagnostics');
        }
        const effectPlan = nativePlan.effectPlan as { effects?: unknown } | undefined;
        if (!effectPlan || !Array.isArray(effectPlan.effects)) {
          throw new Error('Rust HubPipeline response native effect plan unavailable');
        }
        const projected = materializeProviderResponseOutboundEffectPlanWithNativeMock(nativePlan) as Record<string, unknown>;
        if (projected.rawPayload && projected.runtimeEffects && projected.diagnosticInput) {
          return JSON.stringify(projected);
        }
        return JSON.stringify({
          rawPayload: nativePlan.payload,
          runtimeEffects: projected,
          diagnosticInput: {
            requestId: nativePlan.requestId.trim(),
            diagnostics: nativePlan.diagnostics,
          },
        });
      },
      planProviderResponseDiagnosticAlarmEffectJson: (inputJson: string) => {
        const input = JSON.parse(inputJson) as {
          requestId: string;
          diagnostics: Array<{ details?: Record<string, unknown> }>;
        };
        const messages = input.diagnostics.flatMap((diagnostic) => {
          const details = diagnostic.details;
          const alarm = typeof details?.alarm === 'string' ? details.alarm.trim() : '';
          return alarm
            ? [`[hub-pipeline][alarm] ${alarm} requestId=${input.requestId.trim()} details=${JSON.stringify(details)}`]
            : [];
        });
        return JSON.stringify(messages.length > 0 ? { action: 'emit', messages } : { action: 'no_op' });
      },
      planProviderResponseServertoolRetirementEffectJson: (inputJson: string) => JSON.stringify(
        planProviderResponseServertoolRetirementEffectMock(JSON.parse(inputJson))
      ),
      planProviderResponseStoplessRuntimeControlEffectJson: (inputJson: string) => {
        const input = JSON.parse(inputJson) as { stoplessMetadataCenterWrite?: unknown };
        const source = input.stoplessMetadataCenterWrite;
        if (!source) return JSON.stringify({ action: 'no_op' });
        if (typeof source !== 'object' || source === null || Array.isArray(source)) {
          throw new Error('Rust provider response stopless runtime-control planner malformed write plan');
        }
        const parsed = source as Record<string, unknown>;
        const allowed = new Set(['stopless', 'stopMessageCompareContext', 'learnedNote']);
        const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
        if (unknown) throw new Error(`Rust provider response stopless runtime-control planner unknown write-plan field: ${unknown}`);
        const runtimeControl = Object.fromEntries(
          ['stopless', 'stopMessageCompareContext']
            .filter((key) => parsed[key] !== null && parsed[key] !== undefined)
            .map((key) => [key, parsed[key]])
        );
        const projected = { runtimeControl: Object.keys(runtimeControl).length > 0 ? runtimeControl : null };
        return JSON.stringify(projected.runtimeControl ? {
          action: 'apply_runtime_control',
          runtimeControl: projected.runtimeControl,
          writer: { module: 'provider-response.ts', symbol: 'convertProviderResponse', stage: 'HubRespChatProcess03Governed' },
          reason: 'rust response chatprocess runtime control',
        } : { action: 'no_op' });
      },
      planProviderResponseStreamPipeEffectJson: (inputJson: string) => {
        const { streamPipe } = JSON.parse(inputJson) as { streamPipe?: unknown };
        if (streamPipe === null || streamPipe === undefined) return JSON.stringify({ action: 'no_pipe' });
        if (typeof streamPipe !== 'object' || Array.isArray(streamPipe)) {
          throw new Error('Rust HubPipeline response path returned malformed stream pipe effect');
        }
        const pipe = streamPipe as Record<string, unknown>;
        const codec = typeof pipe.codec === 'string' ? pipe.codec.trim() : '';
        const requestId = typeof pipe.requestId === 'string' ? pipe.requestId.trim() : '';
        if ('payload' in pipe || 'body' in pipe) {
          throw new Error('Rust HubPipeline streamPipe effect must not own client payload');
        }
        if (!codec || !requestId) {
          throw new Error('Rust HubPipeline response path returned malformed stream pipe effect');
        }
        return JSON.stringify({ action: 'use_pipe', pipe: { codec, requestId } });
      },
      planProviderResponseStageRecorderEffectJson: (inputJson: string) => {
        const { clientSemantic, streamPipe } = JSON.parse(inputJson) as {
          clientSemantic?: unknown;
          streamPipe?: unknown;
        };
        if (!clientSemantic || typeof clientSemantic !== 'object' || Array.isArray(clientSemantic)) {
          throw new Error('Rust HubPipeline response stage recorder planner missing clientSemantic');
        }
        const protocol = streamPipe === null
          ? 'native-effect-plan'
          : typeof streamPipe === 'object' && streamPipe !== null && !Array.isArray(streamPipe)
            ? String((streamPipe as Record<string, unknown>).codec ?? '').trim()
            : '';
        if (!protocol) {
          throw new Error('Rust HubPipeline response stage recorder planner malformed streamPipe');
        }
        return JSON.stringify({
          records: [
            { stage: 'chat_process.resp.stage9.client_remap', payload: clientSemantic },
            {
              stage: 'chat_process.resp.stage10.sse_stream',
              payload: { passthrough: false, protocol, payload: clientSemantic },
            },
          ],
        });
      },
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
        continuationStoreEffects: [
          {
            operation: 'record_response',
            payload: {
              requestId,
              response: JSON.parse(responseJson),
              ...(JSON.parse(contextJson).sessionId ? { sessionId: JSON.parse(contextJson).sessionId } : {}),
            },
          },
          {
            operation: 'finalize_retention',
            payload: { requestId, options: { keepForSubmitToolOutputs: false } },
          },
        ],
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
    executeResponsesContinuationStoreEffects: jest.fn(),
    getResponsesConversationStoreDebugStats: jest.fn(() => ({})),
  })
);

const { convertProviderResponse } = await import(
  '../../src/modules/llmswitch/bridge/provider-response-converter-host.js'
);
const { executeResponsesContinuationStoreEffects } = await import(
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
    materializeProviderResponseOutboundEffectPlanWithNativeMock.mockClear();
    materializeProviderResponseSsePayloadWithNativeMock.mockClear();
    planChatProcessSessionUsageMock.mockClear();
    buildSseFramesFromJsonWithNativeMock.mockClear();
    executeResponsesContinuationStoreEffects.mockClear();
    executeHubPipelineWithNativeMock.mockReturnValue({
      success: true,
      requestId: 'req_provider_response_center_protocol',
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
    expect(executeResponsesContinuationStoreEffects).toHaveBeenCalledWith([
      expect.objectContaining({
        operation: 'record_response',
        payload: expect.objectContaining({
          requestId: 'openai-responses-provider-20260628T184855563-416867-1902'
        })
      }),
      expect.objectContaining({ operation: 'finalize_retention' })
    ]);
    expect(result.body?.choices?.[0]?.message?.content).toBe('center protocol wins');
  });

  it('fails fast when Rust returns a malformed provider response effect plan', async () => {
    executeHubPipelineWithNativeMock.mockReturnValueOnce({
      success: true,
      requestId: 'req_provider_response_malformed_effect_plan',
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
    })).rejects.toThrow('Rust HubPipeline response native effect plan unavailable');
    expect(materializeProviderResponseOutboundEffectPlanWithNativeMock).not.toHaveBeenCalled();
  });

  it('fails fast when Rust returns malformed provider response servertool runtime actions', async () => {
    materializeProviderResponseOutboundEffectPlanWithNativeMock.mockReturnValueOnce({
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
    materializeProviderResponseOutboundEffectPlanWithNativeMock.mockReturnValueOnce({
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
    materializeProviderResponseOutboundEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: [],
      streamPipe: {
        codec: 'openai-chat'
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
    materializeProviderResponseOutboundEffectPlanWithNativeMock.mockReturnValueOnce({
      runtimeStateWrite: {
        keepForSubmitToolOutputs: false
      },
      servertoolRuntimeActions: [],
      streamPipe: {
        codec: 'openai-responses',
        requestId: 'stale_stream_pipe_request_id'
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
        id: 'chatcmpl_provider_response_center_protocol'
      })
    }));
    expect(buildSseFramesFromJsonWithNativeMock).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stale_stream_pipe_request_id'
    }));
  });
});
