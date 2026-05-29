import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';

import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-state-store.js';
import { persistStopMessageState } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import {
  applyStopMessageSnapshotToState,
  clearStopMessageState
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/routing-state.js';

function createGoalOnlyState(): RoutingInstructionState {
  return {
    stoplessGoalState: {
      status: 'active',
      objective: 'preserve goal state',
      updatedAt: 200,
      createdAt: 100
    },
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

describe('stop_message_auto goal-state preservation', () => {
  const prevSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  let sessionDir = '';
  const stateKey = 'session:goal-preserve';

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stopmsg-goal-'));
    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    if (prevSessionDir === undefined) delete process.env.ROUTECODEX_SESSION_DIR;
    else process.env.ROUTECODEX_SESSION_DIR = prevSessionDir;
  });

  test('does not delete sticky goal state when stop_message fields are cleared', () => {
    const state = createGoalOnlyState();
    saveRoutingInstructionStateSync(stateKey, state);

    const loaded = loadRoutingInstructionStateSync(stateKey) as RoutingInstructionState;
    clearStopMessageState(loaded, Date.now());
    persistStopMessageState(stateKey, loaded);

    const persisted = loadRoutingInstructionStateSync(stateKey) as RoutingInstructionState | null;
    expect(persisted?.stoplessGoalState).toMatchObject({
      status: 'active',
      objective: 'preserve goal state'
    });
  });

  test('merges fallback stop_message snapshot onto existing goal state instead of replacing it', () => {
    const merged = applyStopMessageSnapshotToState(createGoalOnlyState(), {
      text: '继续执行',
      maxRepeats: 1,
      used: 0,
      source: 'explicit',
      updatedAt: 300,
      stageMode: 'on',
      aiMode: 'off'
    });

    expect(merged.stoplessGoalState).toMatchObject({
      status: 'active',
      objective: 'preserve goal state'
    });
    expect(merged.stopMessageText).toBe('继续执行');
    expect(merged.stopMessageStageMode).toBe('on');
  });
});
