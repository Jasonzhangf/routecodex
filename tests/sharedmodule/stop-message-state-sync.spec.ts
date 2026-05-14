import { describe, expect, test } from '@jest/globals';
import { mergeStopMessageFromPersisted } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/stop-message-state-sync.js';

describe('mergeStopMessageFromPersisted stoplessGoalState coverage', () => {
  test('keeps newer in-memory stopless goal state when persisted snapshot is older', () => {
    const existing = {
      stoplessGoalState: {
        status: 'active',
        objective: '实现 RCC stopless',
        updatedAt: 300,
        createdAt: 100
      },
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 200,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };
    const persisted = {
      stoplessGoalState: {
        status: 'paused',
        objective: '旧目标',
        updatedAt: 250,
        createdAt: 100
      },
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 100,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };

    const merged = mergeStopMessageFromPersisted(existing, persisted);

    expect(merged.stoplessGoalState).toEqual(existing.stoplessGoalState);
  });

  test('adopts newer persisted stopless goal state snapshot', () => {
    const existing = {
      stoplessGoalState: {
        status: 'paused',
        objective: '旧目标',
        updatedAt: 200,
        createdAt: 100
      },
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 200,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };
    const persisted = {
      stoplessGoalState: {
        status: 'completed',
        objective: '实现 RCC stopless',
        completionEvidence: 'cargo test passed',
        updatedAt: 400,
        createdAt: 100
      },
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 1,
      stopMessageUpdatedAt: 300,
      stopMessageLastUsedAt: 390,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };

    const merged = mergeStopMessageFromPersisted(existing, persisted);

    expect(merged.stoplessGoalState).toEqual(persisted.stoplessGoalState);
  });
});
