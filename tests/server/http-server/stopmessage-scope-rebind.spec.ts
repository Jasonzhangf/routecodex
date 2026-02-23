import { describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, any>();

const mockBridgeModule = () => ({
  loadRoutingInstructionStateSync: (key: string) => {
    const value = mockStore.get(key);
    if (!value || typeof value !== 'object') {
      return value ?? null;
    }
    return {
      ...value,
      allowedProviders: value.allowedProviders instanceof Set ? new Set([...value.allowedProviders]) : new Set<string>(),
      disabledProviders: value.disabledProviders instanceof Set ? new Set([...value.disabledProviders]) : new Set<string>(),
      disabledKeys: value.disabledKeys instanceof Map ? new Map([...value.disabledKeys.entries()]) : new Map<string, Set<string | number>>(),
      disabledModels: value.disabledModels instanceof Map ? new Map([...value.disabledModels.entries()]) : new Map<string, Set<string>>()
    };
  },
  saveRoutingInstructionStateSync: (key: string, state: unknown | null) => {
    if (!state) {
      mockStore.delete(key);
      return;
    }
    mockStore.set(key, state);
  }
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

function createRoutingState(seed: {
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageUsed?: number;
  stopMessageStageMode?: string;
  stopMessageUpdatedAt?: number;
  preCommandScriptPath?: string;
} = {}): Record<string, unknown> {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: seed.stopMessageText ? 'explicit' : undefined,
    stopMessageText: seed.stopMessageText,
    stopMessageMaxRepeats: seed.stopMessageMaxRepeats,
    stopMessageUsed: seed.stopMessageUsed,
    stopMessageUpdatedAt: seed.stopMessageUpdatedAt,
    stopMessageLastUsedAt: seed.stopMessageUpdatedAt,
    stopMessageStageMode: seed.stopMessageStageMode,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    preCommandSource: seed.preCommandScriptPath ? 'explicit' : undefined,
    preCommandScriptPath: seed.preCommandScriptPath,
    preCommandUpdatedAt: seed.preCommandScriptPath ? Date.now() : undefined
  };
}

describe('stopmessage scope rebind', () => {
  it('migrates active stopMessage state from old tmux scope to new tmux scope', async () => {
    jest.resetModules();
    mockStore.clear();
    const { migrateStopMessageTmuxScope } = await import(
      '../../../src/server/runtime/http-server/stopmessage-scope-rebind.js'
    );

    const oldScope = 'tmux:rcc_old_1';
    const newScope = 'tmux:rcc_new_1';
    mockStore.set(
      oldScope,
      createRoutingState({
        stopMessageText: '继续执行',
        stopMessageMaxRepeats: 5,
        stopMessageUsed: 1,
        stopMessageStageMode: 'on',
        stopMessageUpdatedAt: 123456
      })
    );

    const result = migrateStopMessageTmuxScope({
      oldTmuxSessionId: 'rcc_old_1',
      newTmuxSessionId: 'rcc_new_1',
      reason: 'test'
    });
    expect(result.migrated).toBe(true);
    expect(result.oldScope).toBe(oldScope);
    expect(result.newScope).toBe(newScope);

    const oldState = mockStore.get(oldScope) as Record<string, unknown> | undefined;
    const newState = mockStore.get(newScope) as Record<string, unknown> | undefined;
    expect(oldState?.stopMessageText).toBeUndefined();
    expect(newState?.stopMessageText).toBe('继续执行');
    expect(newState?.stopMessageMaxRepeats).toBe(5);
    expect(newState?.stopMessageUsed).toBe(1);
  });

  it('keeps old scope when no active stopMessage state exists', async () => {
    jest.resetModules();
    mockStore.clear();
    const { migrateStopMessageTmuxScope } = await import(
      '../../../src/server/runtime/http-server/stopmessage-scope-rebind.js'
    );

    const oldScope = 'tmux:rcc_old_2';
    mockStore.set(
      oldScope,
      createRoutingState({
        preCommandScriptPath: '/tmp/script.sh'
      })
    );

    const result = migrateStopMessageTmuxScope({
      oldTmuxSessionId: 'rcc_old_2',
      newTmuxSessionId: 'rcc_new_2',
      reason: 'test_no_stop'
    });
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('old_stopmessage_missing');

    const oldState = mockStore.get(oldScope) as Record<string, unknown> | undefined;
    const newState = mockStore.get('tmux:rcc_new_2') as Record<string, unknown> | undefined;
    expect(oldState?.preCommandScriptPath).toBe('/tmp/script.sh');
    expect(newState).toBeUndefined();
  });
});
