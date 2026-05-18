import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

describe('stopless defaults + goal no-progress threshold regression', () => {
  const envBackup = { ...process.env };

  beforeEach(async () => {
    process.env = { ...envBackup };
    delete process.env.ROUTECODEX_REASONING_STOP_MODE;
    delete process.env.RCC_REASONING_STOP_MODE;
    await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-state.js');
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test('global default reasoning stop mode is endless when no env and no directive', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-state.js');
    expect(mod.DEFAULT_REASONING_STOP_MODE).toBe('endless');
    expect(mod.resolveConfiguredReasoningStopModeDefault()).toBe('endless');
  });

  test('env override still works and can switch default to on/off', async () => {
    process.env.ROUTECODEX_REASONING_STOP_MODE = 'on';
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-state.js');
    expect(mod.resolveConfiguredReasoningStopModeDefault()).toBe('on');

    process.env.ROUTECODEX_REASONING_STOP_MODE = 'off';
    expect(mod.resolveConfiguredReasoningStopModeDefault()).toBe('off');
  });

  test('/goal no-progress threshold is 2 (regression guard)', async () => {
    const goalGuard = await import('../../sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.js');
    expect(goalGuard).toBeTruthy();
    const fs = await import('node:fs/promises');
    const txt = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.js',
      'utf8'
    );
    expect(txt.includes('const NO_PROGRESS_STOP_THRESHOLD = 2;')).toBe(true);
  });

  test('followup policy keeps reasoning_stop_continue as reenter flow', async () => {
    const policy = await import('../../sharedmodule/llmswitch-core/src/servertool/followup-flow-policy.js');
    const decision = policy.resolveFollowupFlowDecision('reasoning_stop_continue_flow');
    expect(decision.outcomeMode).toBe('reenter');
  });
});
