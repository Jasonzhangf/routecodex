import { describe, expect, test } from '@jest/globals';

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
