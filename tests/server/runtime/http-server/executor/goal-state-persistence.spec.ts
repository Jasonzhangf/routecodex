import { describe, expect, it, jest } from '@jest/globals';

const mockPersistStoplessGoalStateSnapshot = jest.fn();

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', () => ({
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot
}));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', () => ({
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot
}));

async function loadGoalStatePersistenceModule() {
  return import('../../../../../src/server/runtime/http-server/executor/goal-state-persistence.js');
}

describe('goal-state-persistence', () => {
  it('persists stopless goal state with session truth from MetadataCenter when flat metadata fields are absent', async () => {
    jest.resetModules();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );
    const goalState = {
      status: 'active',
      objective: 'continue',
      updatedAt: 1,
      createdAt: 1
    };
    const mergedMetadata: Record<string, unknown> = {
      clientTmuxSessionId: 'tmux-1'
    };
    const center = MetadataCenter.attach(mergedMetadata);
    center.writeRuntimeControl(
      'stoplessGoal',
      {
        state: goalState,
        status: 'active'
      },
      {
        module: 'tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts',
        symbol: 'persists stopless goal state with session truth from MetadataCenter when flat metadata fields are absent',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'sessionId',
      'truth-session',
      {
        module: 'tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts',
        symbol: 'persists stopless goal state with session truth from MetadataCenter when flat metadata fields are absent',
        stage: 'test'
      }
    );
    center.writeRequestTruth(
      'conversationId',
      'truth-conversation',
      {
        module: 'tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts',
        symbol: 'persists stopless goal state with session truth from MetadataCenter when flat metadata fields are absent',
        stage: 'test'
      }
    );

    const { persistGoalStateFromMergedMetadata } = await loadGoalStatePersistenceModule();
    persistGoalStateFromMergedMetadata(mergedMetadata);

    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clientTmuxSessionId: 'tmux-1',
        sessionId: 'truth-session',
        conversationId: 'truth-conversation'
      }),
      goalState
    );
    const persistedContext = mockPersistStoplessGoalStateSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persistedContext).not.toHaveProperty('stopMessageClientInjectSessionScope');
  });

  it('persists explicit stop message scope through MetadataCenter without flat adapter fields', async () => {
    jest.resetModules();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    const { MetadataCenter } = await import(
      '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js'
    );
    const goalState = {
      status: 'active',
      objective: 'continue',
      updatedAt: 1,
      createdAt: 1
    };
    const mergedMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(mergedMetadata);
    center.writeRuntimeControl(
      'stoplessGoal',
      {
        state: goalState,
        status: 'active'
      },
      {
        module: 'tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts',
        symbol: 'persists explicit stop message scope through MetadataCenter without flat adapter fields',
        stage: 'test'
      }
    );
    center.writeRuntimeControl(
      'stopMessageClientInject',
      {
        sessionScope: 'tmux:explicit-scope'
      },
      {
        module: 'tests/server/runtime/http-server/executor/goal-state-persistence.spec.ts',
        symbol: 'persists explicit stop message scope through MetadataCenter without flat adapter fields',
        stage: 'test'
      }
    );

    const { persistGoalStateFromMergedMetadata } = await loadGoalStatePersistenceModule();
    persistGoalStateFromMergedMetadata(mergedMetadata);

    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalledTimes(1);
    const persistedContext = mockPersistStoplessGoalStateSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persistedContext).not.toHaveProperty('stopMessageClientInjectSessionScope');
    expect(MetadataCenter.read(persistedContext)?.readRuntimeControl().stopMessageClientInject).toEqual({
      sessionScope: 'tmux:explicit-scope'
    });
  });

  it('does not persist stopless goal state when neither explicit scope nor request truth exists', async () => {
    jest.resetModules();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    const { persistGoalStateFromMergedMetadata } = await loadGoalStatePersistenceModule();
    persistGoalStateFromMergedMetadata({
      stoplessGoalState: {
        status: 'active',
        objective: 'continue'
      },
      sessionId: 'flat-session-should-not-count',
      conversationId: 'flat-conversation-should-not-count'
    });

    expect(mockPersistStoplessGoalStateSnapshot).not.toHaveBeenCalled();
  });
});
