import { describe, expect, it, jest } from '@jest/globals';

const buildCapturedChatRequestSnapshotWithNative = jest.fn((value: unknown) => value);
const buildHubPipelineResultMetadataWithNative = jest.fn(() => ({}));
const applyHasImageAttachmentFlagWithNative = jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => metadata);
const applyOutboundStreamPreferenceWithNative = jest.fn((value: unknown) => value);
const buildReqOutboundNodeResultWithNative = jest.fn(() => ({ stage: 'req_outbound' }));
const buildRouterMetadataInputWithNative = jest.fn(() => ({}));
const resolveOutboundStreamIntentWithNative = jest.fn(() => false);
const syncSessionIdentifiersToMetadataWithNative = jest.fn(({ metadata }: { metadata: Record<string, unknown> }) => metadata);
const runReqProcessStage2RouteSelect = jest.fn(() => ({
  decision: { routeName: 'default' },
  diagnostics: {},
  target: { providerKey: 'test.provider', providerType: 'openai', processMode: 'chat' },
}));
const buildRequestStageProviderPayload = jest.fn(async ({ workingRequest }: { workingRequest: Record<string, unknown> }) => ({
  providerPayload: { ok: true },
  shadowBaselineProviderPayload: undefined,
  outboundWorkingRequest: workingRequest,
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js',
  () => ({
    applyHasImageAttachmentFlagWithNative,
    buildCapturedChatRequestSnapshotWithNative,
    buildHubPipelineResultMetadataWithNative,
    applyOutboundStreamPreferenceWithNative,
    buildReqOutboundNodeResultWithNative,
    buildRouterMetadataInputWithNative,
    resolveOutboundStreamIntentWithNative,
    syncSessionIdentifiersToMetadataWithNative,
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-mutable-record-utils.js',
  () => ({
    replaceMutableRecord: jest.fn((target: Record<string, unknown>, next: Record<string, unknown>) => {
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, next);
      return target;
    }),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-adapter-context.js',
  () => ({
    buildAdapterContextFromNormalized: jest.fn(() => ({ providerProtocol: 'openai-chat' })),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/snapshot-utils.js',
  () => ({ shouldRecordSnapshots: jest.fn(() => false) }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.js',
  () => ({ createSnapshotRecorder: jest.fn() }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/session-identifiers.js',
  () => ({ extractSessionIdentifiersFromMetadata: jest.fn(() => ({})) }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-max-tokens-policy.js',
  () => ({ applyMaxTokensPolicyForRequest: jest.fn() }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.js',
  () => ({
    markHeavyInputFastpath: jest.fn(),
    shouldUseHeavyInputFastpath: jest.fn(() => false),
  }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage2_route_select/index.js',
  () => ({ runReqProcessStage2RouteSelect }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.js',
  () => ({ buildRequestStageProviderPayload }),
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.js',
  () => ({ logHubStageTiming: jest.fn() }),
);

const { executeRouteAndBuildOutbound } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.js'
);

describe('hub pipeline route-and-outbound', () => {
  it('fails fast with captured chat request diagnostics including processMode', async () => {
    buildCapturedChatRequestSnapshotWithNative.mockReturnValueOnce({});

    await expect(
      executeRouteAndBuildOutbound({
        normalized: {
          id: 'req_captured_invalid',
          metadata: {},
          entryEndpoint: '/v1/responses',
          stream: false,
          processMode: 'chat',
          providerProtocol: 'openai-responses',
          routeHint: undefined,
        } as any,
        hooks: { createSemanticMapper: () => ({}) } as any,
        routerEngine: {} as any,
        config: {} as any,
        workingRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }],
        } as any,
        nodeResults: [],
        activeProcessMode: 'chat',
        serverToolRequired: false,
        hasImageAttachment: false,
        rawRequest: {} as any,
        semanticMapper: {} as any,
      }),
    ).rejects.toMatchObject({
      code: 'ERR_CAPTURED_CHAT_REQUEST_INVALID',
      requestId: 'req_captured_invalid',
      processMode: 'chat',
      entryEndpoint: '/v1/responses',
    });
  });
});
