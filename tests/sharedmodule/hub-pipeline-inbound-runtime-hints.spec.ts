import { describe, expect, it, jest } from '@jest/globals';

const buildAdapterContextFromNormalized = jest.fn(() => ({}));
const ensureRuntimeMetadata = jest.fn((metadata: Record<string, unknown>) => {
  if (!metadata.__rt || typeof metadata.__rt !== 'object') {
    metadata.__rt = {};
  }
  return metadata.__rt as Record<string, unknown>;
});
const isCompactionRequest = jest.fn(() => false);
const decideHeavyInputFastpath = jest.fn(() => ({ estimatedTokens: 0, shouldMark: false, source: 'native' }));

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
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    buildToolGovernanceNodeResultWithNative: jest.fn((value: unknown) => value),
    mergeClockReservationIntoMetadataWithNative: jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => metadata),
    prepareRuntimeMetadataForServertoolsWithNative: jest.fn(({ metadata }: { metadata?: Record<string, unknown> }) => ({
      ...(metadata || {}),
    })),
    readResponsesResumeFromMetadataWithNative: jest.fn(() => undefined),
    resolveHubClientProtocolWithNative: jest.fn(() => 'openai-chat'),
    buildReqInboundNodeResultWithNative: jest.fn(() => ({ stage: 'req_inbound' })),
    findMappableSemanticsKeysWithNative: jest.fn(() => []),
    syncResponsesContextFromCanonicalMessagesWithNative: jest.fn((value: unknown) => value),
    buildReqInboundSkippedNodeWithNative: jest.fn(() => ({ stage: 'req_inbound_skipped' })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js',
  () => ({
    sanitizeReqInboundFormatEnvelopeWithNative: jest.fn((value: unknown) => value),
    normalizeProviderProtocolTokenWithNative: jest.fn((value: unknown) => value ?? 'openai-chat'),
    normalizeReqInboundReasoningPayloadWithNative: jest.fn((payload: unknown) => payload),
    mapReqInboundBridgeToolsToChatWithNative: jest.fn((tools: unknown) => tools),
    normalizeContextCaptureLabelWithNative: jest.fn((label: unknown) => String(label ?? 'context')),
    augmentReqInboundContextSnapshotWithNative: jest.fn((context: unknown) => context),
    resolveReqInboundServerToolFollowupSnapshotWithNative: jest.fn(() => undefined),
    buildReqInboundToolOutputSnapshotWithNative: jest.fn(() => ({ stage: 'chat' })),
    captureReqInboundResponsesContextSnapshotWithNative: jest.fn(() => ({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    })),
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
    runReqInboundStage2SemanticMap: jest.fn(async ({ formatEnvelope }: { formatEnvelope: Record<string, unknown> }) => ({
      standardizedRequest: {
        model: String(formatEnvelope.rawRequest?.model || 'gpt-test'),
        messages: formatEnvelope.rawRequest?.messages ?? [{ role: 'user', content: 'hi' }],
        metadata: {},
      },
      responsesContext: undefined,
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

const markHeavyInputFastpath = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.js',
  () => ({
    markHeavyInputFastpath,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath.js',
  () => ({
    decideHeavyInputFastpath,
    loadNativeRouterHotpathBindingForInternalUse: jest.fn(() => ({})),
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
  '../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js',
  () => ({
    captureResponsesRequestContext: jest.fn(),
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
  '../../sharedmodule/llmswitch-core/src/conversion/hub/policy/protocol-spec.js',
  () => ({
    resolveHubProtocolSpec: jest.fn(() => ({
      id: 'openai-chat',
      providerOutbound: {
        enforceEnabled: false,
        reservedKeyPrefixes: [],
        forbidWrappers: [],
        flattenWrappers: [],
      },
      toolSurface: {
        expectedToolFormat: 'openai',
      },
    })),
    getProtocolSpecForPayload: jest.fn(() => ({
      protocol: 'openai-chat',
      allowedTopLevelFields: [],
      allowedParametersWrapperKeys: [],
      messageContentMode: 'openai',
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/protocol-field-allowlists.js',
  () => ({
    OPENAI_CHAT_ALLOWED_FIELDS: [],
    ANTHROPIC_ALLOWED_FIELDS: [],
    OPENAI_RESPONSES_ALLOWED_FIELDS: [],
    GEMINI_ALLOWED_FIELDS: [],
    OPENAI_RESPONSES_PARAMETERS_WRAPPER_ALLOW_KEYS: [],
    OPENAI_CHAT_PARAMETERS_WRAPPER_ALLOW_KEYS: [],
    ANTHROPIC_PARAMETERS_WRAPPER_ALLOW_KEYS: [],
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/compaction-detect.js',
  () => ({
    isCompactionRequest,
  }),
);

const { executeRequestStageInbound } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.js'
);

describe('hub pipeline inbound runtime hints', () => {

  it('uses native heavy-input fastpath decision and persists estimated tokens', async () => {
    decideHeavyInputFastpath.mockReturnValueOnce({
      estimatedTokens: 123456,
      shouldMark: true,
      reason: 'rough_estimate',
      source: 'native',
    });

    const normalized = {
      id: 'req_hint_heavy_input_native',
      payload: {
        messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      },
      metadata: {},
      processMode: 'chat',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stream: false,
      routeHint: undefined,
    } as any;

    await executeRequestStageInbound({
      normalized,
      hooks: {
        createSemanticMapper: () => ({}),
        captureContext: jest.fn(async () => undefined),
      } as any,
      config: {} as any,
    });

    expect(decideHeavyInputFastpath).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      }),
      normalized.metadata as Record<string, unknown>,
    );
    expect((normalized.metadata as Record<string, unknown>).estimatedInputTokens).toBe(123456);
    expect(markHeavyInputFastpath).toHaveBeenCalledWith({
      metadata: normalized.metadata,
      estimatedInputTokens: 123456,
      reason: 'rough_estimate',
    });
  });
  it('does not let inbound runtime hints own applyPatchToolMode', async () => {
    const payload = {
      tools: [{ type: 'function', function: { name: 'apply_patch' } }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const normalized = {
      id: 'req_hint_tools_payload_object',
      payload,
      metadata: {},
      processMode: 'chat',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stream: false,
      routeHint: undefined,
    } as any;

    await executeRequestStageInbound({
      normalized,
      hooks: {
        createSemanticMapper: () => ({}),
        captureContext: jest.fn(async () => undefined),
      } as any,
      config: {} as any,
    });

    const rt = ((normalized.metadata as Record<string, unknown>).__rt ?? {}) as Record<string, unknown>;
    expect(rt.applyPatchToolMode).toBeUndefined();
  });

  it('does not derive applyPatchToolMode from top-level tools in inbound stage', async () => {
    const normalized = {
      id: 'req_hint_tools',
      payload: {
        tools: [{ type: 'function', function: { name: 'apply_patch' } }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      metadata: {},
      processMode: 'chat',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stream: false,
      routeHint: undefined,
    } as any;

    await executeRequestStageInbound({
      normalized,
      hooks: {
        createSemanticMapper: () => ({}),
        captureContext: jest.fn(async () => undefined),
      } as any,
      config: {} as any,
    });

    const rt = ((normalized.metadata as Record<string, unknown>).__rt ?? {}) as Record<string, unknown>;
    expect(rt.applyPatchToolMode).toBeUndefined();
  });

  it('does not set applyPatchToolMode when tools are absent at top-level payload', async () => {
    const normalized = {
      id: 'req_hint_no_top_tools',
      payload: {
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        messages: [{ role: 'user', content: 'hi' }],
      },
      metadata: {},
      processMode: 'chat',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stream: false,
      routeHint: undefined,
    } as any;

    await executeRequestStageInbound({
      normalized,
      hooks: {
        createSemanticMapper: () => ({}),
        captureContext: jest.fn(async () => undefined),
      } as any,
      config: {} as any,
    });

    const rt = ((normalized.metadata as Record<string, unknown>).__rt ?? {}) as Record<string, unknown>;
    expect(rt.applyPatchToolMode).toBeUndefined();
  });
});
