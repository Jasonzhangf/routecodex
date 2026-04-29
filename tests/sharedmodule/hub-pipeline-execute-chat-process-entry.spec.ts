import { describe, expect, it, jest } from '@jest/globals';

const runReqProcessStage1ToolGovernance = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    ensureRuntimeMetadata: jest.fn((value: unknown) => value ?? {}),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js',
  () => ({
    shouldRecordSnapshots: jest.fn(() => false),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-stage-hooks.js',
  () => ({
    REQUEST_STAGE_HOOKS: {
      openai: {},
    },
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    buildReqInboundSkippedNodeWithNative: jest.fn(() => ({ stage: 'req_inbound_skipped' })),
    coerceStandardizedRequestFromPayloadWithNative: jest.fn(({ payload }: { payload: Record<string, unknown> }) => ({
      standardizedRequest: {
        model: String(payload.model || 'test-model'),
        messages: [],
      },
      rawPayload: payload,
    })),
    findMappableSemanticsKeysWithNative: jest.fn(() => []),
    liftResponsesResumeIntoSemanticsWithNative: jest.fn(() => {
      throw new Error('lift boom');
    }),
    prepareRuntimeMetadataForServertoolsWithNative: jest.fn(
      ({ metadata }: { metadata?: Record<string, unknown> }) => ({ ...(metadata || {}) }),
    ),
    syncResponsesContextFromCanonicalMessagesWithNative: jest.fn((value: unknown) => value),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js',
  () => ({
    runReqProcessStage1ToolGovernance,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.js',
  () => ({
    buildAdapterContextFromNormalized: jest.fn(() => ({})),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.js',
  () => ({
    deriveWorkingRequestFlags: jest.fn(() => ({})),
    estimateInputTokensForWorkingRequest: jest.fn(),
    prepareReasoningStopRequestTooling: jest.fn(),
    propagateApplyPatchToolModeToRequestMetadata: jest.fn(),
    resolveActiveProcessModeAndAudit: jest.fn(() => ({
      activeProcessMode: 'normal',
      passthroughAudit: {},
    })),
    sanitizeStandardizedRequestMessages: jest.fn((value: unknown) => value),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-governance-utils.js',
  () => ({
    annotatePassthroughAuditSkipped: jest.fn(),
    appendPassthroughGovernanceSkippedNode: jest.fn(),
    appendToolGovernanceNodeResult: jest.fn(),
    propagateClockReservationToMetadata: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.js',
  () => ({
    createSnapshotRecorder: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.js',
  () => ({
    executeRouteAndBuildOutbound: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js',
  () => ({
    peekHubStageTopSummary: jest.fn(() => null),
  }),
);

const { executeChatProcessEntryPipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.js'
);

describe('executeChatProcessEntryPipeline', () => {
  it('fails fast when semantic lift throws before chat_process', async () => {
    runReqProcessStage1ToolGovernance.mockReset();

    await expect(
      executeChatProcessEntryPipeline({
        normalized: {
          id: 'req_semantic_lift',
          providerProtocol: 'openai',
          payload: {
            model: 'mimo-v2.5-pro',
            messages: [],
          },
          metadata: {},
          entryEndpoint: '/v1/responses',
          stream: false,
          processMode: 'default',
          routeHint: null,
        } as any,
        routerEngine: {} as any,
        config: {} as any,
      }),
    ).rejects.toThrow(
      '[HubPipeline][semantic_gate] Failed to lift protocol semantics into request.semantics before chat_process (requestId=req_semantic_lift): lift boom',
    );

    expect(runReqProcessStage1ToolGovernance).not.toHaveBeenCalled();
  });
});
