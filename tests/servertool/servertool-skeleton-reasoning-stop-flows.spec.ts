import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const skeletonDocument = {
  version: 1,
  servertool: {
    enabled: true,
    internalTools: {},
    skeleton: {
      finalizeStrip: { enabled: true, requireFinalizedMarker: true },
      autoHooks: { optionalPrimaryOrder: [], mandatoryOrder: [] },
      pendingInjection: { messageKinds: [] },
      progress: { toolNameByFlowId: {}, goldHighlightFlowIds: [] },
      followup: {
        genericInjectionOps: [],
        nativeSupportedOps: [],
        flowPolicy: {
          profilesByFlowId: {}
        }
      }
    },
    state: {
      scopePriority: [],
      pendingInjection: { enabled: true, strictContract: true }
    }
  }
};

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    getDefaultServertoolSkeletonDocumentWithNative: jest.fn(() => skeletonDocument),
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({
      document: skeletonDocument,
      toolSpecs: {},
      toolSpecList: [],
      autoHookQueueConfig: { optionalPrimaryOrder: [], mandatoryOrder: [] },
      pendingInjectionConfig: { messageKinds: [] },
      followupConfig: {
        genericInjectionOps: [],
        nativeSupportedOps: [],
        flowPolicy: {
          profilesByFlowId: skeletonDocument.servertool.skeleton.followup.flowPolicy.profilesByFlowId,
          noFollowupFlowIds: [],
          autoLimitFlowIds: [],
          flowOnlyLoopLimitFlowIds: [],
          clientInjectOnlyFlowIds: [],
          seedLoopPayloadFlowIds: [],
          clientInjectSourceByFlowId: {},
          transparentReplayRequestSuffixByFlowId: {},
          ignoreRequiresActionFollowupFlowIds: []
        }
      },
      stateConfig: skeletonDocument.servertool.state
    })),
    normalizeServertoolRegistrationSpecWithNative: jest.fn(() => null),
    resolveServertoolToolSpecWithNative: jest.fn(() => null),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn(() => ({})),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({ names: [] })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({ entries: [] })),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn(() => ({ action: 'return_null' })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn(() => null)
  })
);

describe('servertool skeleton reasoning-stop flow profiles', () => {
  test('does not expose reasoning stop flows through server-side skeleton policy', () => {
    const doc = skeletonDocument;
    const profiles = doc.servertool.skeleton.followup.flowPolicy.profilesByFlowId ?? {};

    expect(profiles).toEqual({});
    expect(profiles.reasoning_stop_guard_flow).toBeUndefined();
    expect(profiles.reasoning_stop_finalize_flow).toBeUndefined();
    expect(profiles.reasoning_stop_continue_flow).toBeUndefined();
  });
});
