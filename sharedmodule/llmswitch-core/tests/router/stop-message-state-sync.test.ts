import { describe, expect, test } from '@jest/globals';
import { mergeStopMessageFromPersisted } from '../../src/router/virtual-router/stop-message-state-sync.js';

describe('mergeStopMessageFromPersisted', () => {
  test('prefers persisted usage progress for the same stopMessage config', () => {
    const existing = {
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 200,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off',
      stopMessageAiSeedPrompt: undefined,
      stopMessageAiHistory: undefined
    };
    const persisted = {
      stopMessageSource: 'explicit_text',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 12,
      stopMessageUpdatedAt: 100,
      stopMessageLastUsedAt: 190,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off',
      stopMessageAiSeedPrompt: 'seed',
      stopMessageAiHistory: [{ round: 12 }]
    };

    const merged = mergeStopMessageFromPersisted(existing, persisted);

    expect(merged.stopMessageUpdatedAt).toBe(200);
    expect(merged.stopMessageUsed).toBe(12);
    expect(merged.stopMessageLastUsedAt).toBe(190);
    expect(merged.stopMessageAiSeedPrompt).toBe('seed');
    expect(merged.stopMessageAiHistory).toEqual([{ round: 12 }]);
  });

  test('does not overlay persisted usage when stopMessage config changed', () => {
    const existing = {
      stopMessageSource: 'explicit_text',
      stopMessageText: '新的 stop',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 200,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };
    const persisted = {
      stopMessageSource: 'explicit_text',
      stopMessageText: '旧的 stop',
      stopMessageMaxRepeats: 20,
      stopMessageUsed: 12,
      stopMessageUpdatedAt: 100,
      stopMessageLastUsedAt: 190,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    };

    const merged = mergeStopMessageFromPersisted(existing, persisted);

    expect(merged.stopMessageText).toBe('新的 stop');
    expect(merged.stopMessageUsed).toBe(0);
    expect(merged.stopMessageLastUsedAt).toBeUndefined();
  });
});
