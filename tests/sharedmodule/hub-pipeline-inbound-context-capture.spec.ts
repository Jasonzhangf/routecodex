import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const buildAdapterContextFromNormalized = jest.fn((normalized: Record<string, unknown>) => ({
  requestId: normalized.id,
  entryEndpoint: normalized.entryEndpoint,
  providerProtocol: normalized.providerProtocol,
  routeId: normalized.routeHint,
}));
const mockCaptureReqInboundResponsesContextSnapshotWithNative = jest.fn();
const mockCaptureResponsesRequestContext = jest.fn();
const mockResolveHubClientProtocolWithNative = jest.fn();
const ensureRuntimeMetadata = jest.fn((metadata: Record<string, unknown>) => {
  if (!metadata.__rt || typeof metadata.__rt !== 'object') {
    metadata.__rt = {};
  }
  return metadata.__rt as Record<string, unknown>;
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.js',
  () => ({
    buildAdapterContextFromNormalized,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.js',
  () => ({
    createSnapshotRecorder: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js',
  () => ({
    shouldRecordSnapshots: jest.fn(() => false),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js',
  () => ({
    writeCacheEntryForRequest: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js',
  () => ({
    captureResponsesRequestContext: mockCaptureResponsesRequestContext,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    buildReqInboundNodeResultWithNative: jest.fn(() => ({ stage: 'req_inbound' })),
    annotatePassthroughGovernanceSkipWithNative: jest.fn((audit: unknown) => audit ?? {}),
    buildPassthroughGovernanceSkippedNodeWithNative: jest.fn(() => ({ stage: 'req_process_skipped' })),
    buildPassthroughAuditWithNative: jest.fn(() => ({ mode: 'passthrough' })),
    buildToolGovernanceNodeResultWithNative: jest.fn((value: unknown) => value),
    findMappableSemanticsKeysWithNative: jest.fn(() => []),
    mergeClockReservationIntoMetadataWithNative: jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => metadata),
    prepareRuntimeMetadataForServertoolsWithNative: jest.fn(({ metadata }: { metadata?: Record<string, unknown> }) => ({
      ...(metadata || {}),
    })),
    readResponsesResumeFromMetadataWithNative: jest.fn(() => undefined),
    resolveActiveProcessModeWithNative: jest.fn((mode: unknown) => mode ?? 'chat'),
    resolveHubClientProtocolWithNative: mockResolveHubClientProtocolWithNative,
    syncResponsesContextFromCanonicalMessagesWithNative: jest.fn((value: unknown) => value),
    extractAdapterContextMetadataFieldsWithNative: jest.fn(() => ({})),
    resolveAdapterContextMetadataSignalsWithNative: jest.fn(() => ({})),
    resolveAdapterContextObjectCarriersWithNative: jest.fn(() => ({})),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js',
  () => ({
    sanitizeReqInboundFormatEnvelopeWithNative: jest.fn((value: unknown) => value),
    applyReqInboundSemanticLiftWithNative: jest.fn((value: unknown) => value),
    buildReqInboundToolOutputSnapshotWithNative: jest.fn(() => ({ stage: 'chat' })),
    captureReqInboundResponsesContextSnapshotWithNative:
      mockCaptureReqInboundResponsesContextSnapshotWithNative,
    normalizeReqInboundReasoningPayloadWithNative: jest.fn((payload: unknown) => payload),
    normalizeReasoningPayloadV2WithNative: jest.fn((payload: unknown) => payload),
    shouldNormalizeReasoningPayloadWithNative: jest.fn(() => false),
    mapReqInboundBridgeToolsToChatWithNative: jest.fn((tools: unknown) => tools),
    normalizeContextCaptureLabelWithNative: jest.fn((label: unknown) => String(label ?? 'context')),
    normalizeReqInboundToolCallIdStyleWithNative: jest.fn((value: unknown) => value ?? 'preserve'),
    normalizeProviderProtocolTokenWithNative: jest.fn((value: unknown) => value ?? 'openai-chat'),
    augmentReqInboundContextSnapshotWithNative: jest.fn((context: unknown) => context),
    resolveReqInboundServerToolFollowupSnapshotWithNative: jest.fn(() => undefined),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage1_format_parse/index.js',
  () => ({
    runReqInboundStage1FormatParse: jest.fn(async ({ rawRequest }: { rawRequest: Record<string, unknown> }) => ({
      rawRequest,
      format: 'chat',
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.js',
  () => ({
    runReqInboundStage2SemanticMap: jest.fn(async ({ formatEnvelope, adapterContext }: { formatEnvelope: Record<string, unknown>; adapterContext: Record<string, unknown> }) => ({
      standardizedRequest: {
        model: String(formatEnvelope.rawRequest?.model || 'gpt-test'),
        messages:
          formatEnvelope.rawRequest?.messages ??
          [{ role: 'user', content: 'hi' }],
        metadata: {},
      },
      responsesContext:
        String(adapterContext.requestId || '') === 'req_capture_responses_fallback'
          ? undefined
          : String(adapterContext.entryEndpoint || '').includes('/v1/responses')
          ? {
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'hi' }],
                },
              ],
            }
          : undefined,
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js',
  () => ({
    runReqProcessStage1ToolGovernance: jest.fn(async () => ({
      processedRequest: undefined,
      nodeResult: { success: true, metadata: {} },
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-media.js',
  () => ({
    containsImageAttachment: jest.fn(() => false),
    stripHistoricalImageAttachments: jest.fn((messages: unknown) => messages),
    stripHistoricalVisualToolOutputs: jest.fn((messages: unknown) => messages),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/token-estimator.js',
  () => ({
    computeRequestTokens: jest.fn(() => 0),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-session-usage.js',
  () => ({
    estimateSessionBoundTokens: jest.fn(() => 0),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.js',
  () => ({
    isHeavyInputFastpathEnabled: jest.fn(() => false),
    markHeavyInputFastpath: jest.fn(),
    resolveHeavyInputTokenThreshold: jest.fn(() => 180000),
    roughEstimateInputTokensFromRequest: jest.fn(() => undefined),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js',
  () => ({
    measureHubStage: jest.fn(async (_requestId: string, _stage: string, fn: () => unknown) => await fn()),
    logHubStageTiming: jest.fn(),
    isHubStageTimingDetailEnabled: jest.fn(() => false),
    peekHubStageTopSummary: jest.fn(() => []),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    ensureRuntimeMetadata,
    readRuntimeMetadata: jest.fn((metadata: Record<string, unknown>) => {
      if (!metadata.__rt || typeof metadata.__rt !== 'object') {
        metadata.__rt = {};
      }
      return metadata.__rt as Record<string, unknown>;
    }),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/compaction-detect.js',
  () => ({
    isCompactionRequest: jest.fn(() => false),
  }),
);

const { executeRequestStageInbound } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.js'
);
const { captureResponsesContextSnapshot } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage3_context_capture/index.js'
);

describe('hub inbound context capture', () => {
  beforeEach(() => {
    mockCaptureResponsesRequestContext.mockReset();
    mockResolveHubClientProtocolWithNative.mockReset();
    mockCaptureReqInboundResponsesContextSnapshotWithNative.mockReset();
  });

  it('captures responses conversation context only for openai-responses protocol', async () => {
    mockResolveHubClientProtocolWithNative.mockReturnValue('openai-responses');

    await executeRequestStageInbound({
      normalized: {
        id: 'req_capture_responses_only',
        payload: { input: [{ role: 'user', content: 'hi' }] },
        metadata: {},
        processMode: 'chat',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: false,
        routeHint: undefined,
      } as any,
      hooks: {
        createSemanticMapper: () => ({ toChat: jest.fn() }),
        captureContext: jest.fn(),
      } as any,
      config: {} as any,
    });

    expect(mockCaptureResponsesRequestContext).toHaveBeenCalledTimes(1);
    expect(mockCaptureResponsesRequestContext.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'req_capture_responses_only',
    });
  });

  it('does not capture responses conversation context for non-responses protocol', async () => {
    mockResolveHubClientProtocolWithNative.mockReturnValue('openai-chat');

    await executeRequestStageInbound({
      normalized: {
        id: 'req_capture_chat',
        payload: { messages: [{ role: 'user', content: 'hi' }] },
        metadata: {},
        processMode: 'chat',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        stream: false,
        routeHint: undefined,
      } as any,
      hooks: {
        createSemanticMapper: () => ({ toChat: jest.fn() }),
        captureContext: jest.fn(),
      } as any,
      config: {} as any,
    });

    expect(mockCaptureResponsesRequestContext).not.toHaveBeenCalled();
  });

  it('captures submit_tool_outputs resume shape for responses without requiring chat messages', () => {
    mockCaptureReqInboundResponsesContextSnapshotWithNative.mockReturnValue({
      requestId: 'req_submit_tool_outputs_resume',
      isChatPayload: false,
      isResponsesPayload: false,
      __captured_tool_results: [
        {
          tool_call_id: 'call_apply_patch_1',
          call_id: 'call_apply_patch_1',
          output: 'Patch applied successfully',
        },
      ],
    });

    const captured = captureResponsesContextSnapshot({
      rawRequest: {
        model: 'gpt-5.4',
        previous_response_id: 'resp_prev_1',
        tool_outputs: [
          {
            tool_call_id: 'call_apply_patch_1',
            output: 'Patch applied successfully',
          },
        ],
        stream: false,
      } as any,
      adapterContext: {
        requestId: 'req_submit_tool_outputs_resume',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      } as any,
      stageRecorder: undefined,
    });

    expect(mockCaptureReqInboundResponsesContextSnapshotWithNative).toHaveBeenCalledTimes(1);
    expect(mockCaptureReqInboundResponsesContextSnapshotWithNative.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'req_submit_tool_outputs_resume',
      rawRequest: {
        previous_response_id: 'resp_prev_1',
        tool_outputs: [
          {
            tool_call_id: 'call_apply_patch_1',
            output: 'Patch applied successfully',
          },
        ],
      },
    });
    expect(captured).toMatchObject({
      requestId: 'req_submit_tool_outputs_resume',
      isChatPayload: false,
      isResponsesPayload: false,
    });
  });

  it('persists responses conversation context from fallback hook path exactly once', async () => {
    mockResolveHubClientProtocolWithNative.mockReturnValue('openai-responses');

    const fallbackContext = {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    };
    const captureContext = jest.fn(async () => fallbackContext);

    const result = await executeRequestStageInbound({
      normalized: {
        id: 'req_capture_responses_fallback',
        payload: { input: [{ role: 'user', content: 'hi' }] },
        metadata: {},
        processMode: 'chat',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        stream: false,
        routeHint: undefined,
      } as any,
      hooks: {
        createSemanticMapper: () => ({ toChat: jest.fn() }),
        captureContext,
      } as any,
      config: {} as any,
    });

    expect(captureContext).toHaveBeenCalledTimes(1);
    expect(mockCaptureResponsesRequestContext).toHaveBeenCalledTimes(1);
    expect(mockCaptureResponsesRequestContext.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'req_capture_responses_fallback',
      context: fallbackContext,
    });
    expect(result.contextSnapshot).toBe(fallbackContext);
  });

  it('does not persist responses conversation store inside stage3 helper directly', () => {
    mockCaptureReqInboundResponsesContextSnapshotWithNative.mockReturnValue({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });

    const result = captureResponsesContextSnapshot({
      rawRequest: { input: [{ role: 'user', content: 'hi' }] } as any,
      adapterContext: {
        requestId: 'req_capture_responses_stage3_helper',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
      } as any,
    });

    expect(mockCaptureResponsesRequestContext).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
  });
});
