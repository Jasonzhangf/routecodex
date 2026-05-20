import { describe, expect, it, jest } from '@jest/globals';

const buildAdapterContextFromNormalized = jest.fn(() => ({}));
const resolveApplyPatchToolModeFromToolsWithNative = jest.fn(() => 'schema');
const ensureRuntimeMetadata = jest.fn((metadata: Record<string, unknown>) => {
  if (!metadata.__rt || typeof metadata.__rt !== 'object') {
    metadata.__rt = {};
  }
  return metadata.__rt as Record<string, unknown>;
});
const isCompactionRequest = jest.fn(() => false);

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
    resolveApplyPatchToolModeFromToolsWithNative,
    annotatePassthroughGovernanceSkipWithNative: jest.fn((audit: unknown) => audit ?? {}),
    buildPassthroughGovernanceSkippedNodeWithNative: jest.fn(() => ({ stage: 'req_process_skipped' })),
    buildPassthroughAuditWithNative: jest.fn(() => ({ mode: 'passthrough' })),
    buildToolGovernanceNodeResultWithNative: jest.fn((value: unknown) => value),
    mergeClockReservationIntoMetadataWithNative: jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => metadata),
    resolveActiveProcessModeWithNative: jest.fn((mode: unknown) => mode ?? 'chat'),
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
  '../../sharedmodule/llmswitch-core/src/conversion/compaction-detect.js',
  () => ({
    isCompactionRequest,
  }),
);

const { executeRequestStageInbound } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.js'
);

describe('hub pipeline inbound runtime hints', () => {
  it('derives applyPatchToolMode from top-level tools on payload object', async () => {
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

    expect(resolveApplyPatchToolModeFromToolsWithNative).toHaveBeenCalledWith(payload.tools);
  });

  it('derives applyPatchToolMode from top-level tools', async () => {
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

    expect(resolveApplyPatchToolModeFromToolsWithNative).toHaveBeenCalled();
  });

  it('does not set applyPatchToolMode when tools are absent at top-level payload', async () => {
    resolveApplyPatchToolModeFromToolsWithNative.mockReturnValueOnce(undefined);
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
