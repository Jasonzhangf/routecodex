import { describe, expect, it, jest } from '@jest/globals';

const runReqProcessStage1ToolGovernance = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    ensureRuntimeMetadata: jest.fn((value: unknown) => value ?? {}),
    readRuntimeMetadata: jest.fn((value: unknown) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined,
    ),
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
      'openai-chat': {
        createSemanticMapper: jest.fn(() => ({})),
      },
    },
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    buildReqInboundSkippedNodeWithNative: jest.fn(() => ({ stage: 'req_inbound_skipped' })),
    annotatePassthroughGovernanceSkipWithNative: jest.fn((value: unknown) => value),
    buildPassthroughGovernanceSkippedNodeWithNative: jest.fn(() => ({ stage: 'tool_governance_skipped' })),
    buildPassthroughAuditWithNative: jest.fn(() => ({ mode: 'passthrough' })),
    buildToolGovernanceNodeResultWithNative: jest.fn((value: unknown) => value),
    coerceStandardizedRequestFromPayloadWithNative: jest.fn(({ payload }: { payload: Record<string, unknown> }) => ({
      standardizedRequest: {
        model: String(payload.model || 'test-model'),
        messages: payload.messages ?? [],
        metadata: {},
      },
      rawPayload: payload,
    })),
    findMappableSemanticsKeysWithNative: jest.fn(() => []),
    liftResponsesResumeIntoSemanticsWithNative: jest.fn((_request: unknown, metadata: Record<string, unknown>) => ({
      request: {
        model: 'mimo-v2.5-pro',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {},
      },
      metadata: {
        ...metadata,
        __rt: {
          ...(metadata.__rt && typeof metadata.__rt === 'object'
            ? (metadata.__rt as Record<string, unknown>)
            : {}),
          liftedFlag: true,
        },
      },
    })),
    prepareRuntimeMetadataForServertoolsWithNative: jest.fn(
      ({ metadata }: { metadata?: Record<string, unknown> }) => ({ ...(metadata || {}) }),
    ),
    mergeClockReservationIntoMetadataWithNative: jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => ({
      ...metadata,
    })),
    resolveActiveProcessModeWithNative: jest.fn((_processMode: unknown) => 'chat'),
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
  '../../sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.js',
  () => ({
    createSnapshotRecorder: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.js',
  () => ({
    executeRouteAndBuildOutbound: jest.fn(({ normalized }: { normalized: { metadata: Record<string, unknown> } }) => ({
      metadata: normalized.metadata,
      providerPayload: { ok: true },
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-inbound.js',
  () => ({
    finalizeWorkingRequestForOutbound: jest.fn(({ request }: { request: Record<string, unknown> }) => ({
      workingRequest: request,
      hasImageAttachment: false,
      serverToolRequired: false,
    })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js',
  () => ({
    peekHubStageTopSummary: jest.fn(() => []),
  }),
);

const { executeChatProcessEntryPipeline } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.js'
);

describe('hub pipeline metadata merge contract', () => {
  it('keeps existing __rt fields when semantic lift returns metadata patch', async () => {
    runReqProcessStage1ToolGovernance.mockResolvedValue({
      processedRequest: {
        model: 'mimo-v2.5-pro',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        metadata: {},
      },
      nodeResult: {
        success: true,
        metadata: {},
      },
    });

    const normalized = {
      id: 'req_merge_contract',
      providerProtocol: 'openai-chat',
      payload: {
        model: 'mimo-v2.5-pro',
        messages: [{ role: 'user', content: 'hello' }],
      },
      metadata: {
        __rt: {
          keepMe: 'yes',
          existingCounter: 3,
        },
      },
      entryEndpoint: '/v1/chat/completions',
      stream: false,
      processMode: 'chat',
      routeHint: null,
    } as any;

    const result = await executeChatProcessEntryPipeline({
      normalized,
      routerEngine: {} as any,
      config: {} as any,
    });

    const rt = ((result.metadata as Record<string, unknown>).__rt ?? {}) as Record<string, unknown>;
    expect(rt.keepMe).toBe('yes');
    expect(rt.existingCounter).toBe(3);
    expect(rt.liftedFlag).toBe(true);
  });
});
