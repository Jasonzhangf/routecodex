import { describe, expect, test } from '@jest/globals';

import { applyRoutingInstructions } from '../../src/router/virtual-router/routing-instructions.js';
import type { RoutingInstructionState } from '../../src/router/virtual-router/routing-instructions.js';

function createState(): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(['provider-a']),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageSource: 'explicit',
    stopMessageText: '继续执行',
    stopMessageMaxRepeats: 5,
    stopMessageUsed: 2,
    stopMessageUpdatedAt: 123,
    stopMessageLastUsedAt: 122,
    stopMessageStageMode: 'on',
    stopMessageAiMode: 'off',
    stopMessageAiSeedPrompt: 'seed',
    stopMessageAiHistory: [{ role: 'assistant', content: 'history' }],
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

describe('stop message clear semantics', () => {
  test('clear instruction resets stopMessage fields', () => {
    const next = applyRoutingInstructions([{ type: 'clear' } as any], createState());
    expect(next.stopMessageText).toBeUndefined();
    expect(next.stopMessageMaxRepeats).toBeUndefined();
    expect(next.stopMessageUsed).toBeUndefined();
    expect(next.stopMessageUpdatedAt).toBeUndefined();
    expect(next.stopMessageLastUsedAt).toBeUndefined();
    expect(next.stopMessageSource).toBeUndefined();
    expect(next.stopMessageStageMode).toBeUndefined();
    expect(next.stopMessageAiMode).toBeUndefined();
    expect(next.stopMessageAiSeedPrompt).toBeUndefined();
    expect(next.stopMessageAiHistory).toBeUndefined();
    expect(next.allowedProviders.size).toBe(0);
  });

  test('stopMessageClear instruction clears stopMessage fields only', () => {
    const next = applyRoutingInstructions([{ type: 'stopMessageClear' } as any], createState());
    expect(next.stopMessageText).toBeUndefined();
    expect(next.stopMessageMaxRepeats).toBeUndefined();
    expect(next.stopMessageUsed).toBeUndefined();
    expect(next.stopMessageUpdatedAt).toBeUndefined();
    expect(next.stopMessageLastUsedAt).toBeUndefined();
    expect(next.stopMessageSource).toBeUndefined();
    expect(next.stopMessageStageMode).toBeUndefined();
    expect(next.stopMessageAiMode).toBeUndefined();
    expect(next.stopMessageAiSeedPrompt).toBeUndefined();
    expect(next.stopMessageAiHistory).toBeUndefined();
    expect(next.allowedProviders.size).toBe(1);
  });
});
