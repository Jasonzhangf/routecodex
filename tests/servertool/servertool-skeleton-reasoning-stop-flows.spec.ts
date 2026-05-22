import { getDefaultServertoolSkeletonDocument } from '../../sharedmodule/llmswitch-core/src/servertool/skeleton-config.js';

describe('servertool skeleton reasoning-stop flow profiles', () => {
  test('exposes reasoning stop flows as native followup policy truth', () => {
    const doc = getDefaultServertoolSkeletonDocument();
    const profiles = doc.servertool.skeleton.followup.flowPolicy.profilesByFlowId ?? {};

    expect(profiles.reasoning_stop_guard_flow).toBeDefined();
    expect(profiles.reasoning_stop_finalize_flow).toBeDefined();
    expect(profiles.reasoning_stop_continue_flow).toBeDefined();
  });
});
