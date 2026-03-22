import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

describe('clock-runtime-hooks', () => {
  it('auto-disables clock injection when clock.md stop policy is no-open-tasks and checklist is complete', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-clock-stop-when-complete-'));
    fs.writeFileSync(
      path.join(tmpDir, 'clock.md'),
      [
        '# Clock',
        'Clock-Stop-When: no-open-tasks',
        '',
        '- [x] done-a',
        '- [x] done-b',
        ''
      ].join('\n'),
      'utf8'
    );

    let capturedHooks: any;
    const injectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true as const }));

    await jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
      setClockRuntimeHooksSnapshot: async (hooks: unknown) => {
        capturedHooks = hooks;
      }
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      injectSessionClientPromptWithResult
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-injection-history.js', () => ({
      appendTmuxInjectionHistoryEvent: () => Promise.resolve(true)
    }));

    const mod = await import('../../../../src/server/runtime/http-server/clock-runtime-hooks.js');
    await mod.registerClockRuntimeHooks();

    expect(typeof capturedHooks?.dispatchDueTask).toBe('function');
    const result = await capturedHooks.dispatchDueTask({
      sessionId: 'tmux:clock-stop-complete',
      tmuxSessionId: 'tmux:clock-stop-complete',
      task: { taskId: 'task-stop-complete' },
      injectText: '[Clock Reminder]'
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        cleanupSession: true,
        reason: 'clock_all_tasks_completed'
      })
    );
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-disables clock injection when clock.md stop policy is no-open-tasks but no checklist exists', async () => {
    jest.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-clock-stop-when-empty-'));
    fs.writeFileSync(
      path.join(tmpDir, 'clock.md'),
      [
        '# Clock',
        'Clock-Stop-When: no-open-tasks',
        '',
        'No checklist task here.',
        ''
      ].join('\n'),
      'utf8'
    );

    let capturedHooks: any;
    const injectSessionClientPromptWithResult = jest.fn(async () => ({ ok: true as const }));

    await jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => ({
      setClockRuntimeHooksSnapshot: async (hooks: unknown) => {
        capturedHooks = hooks;
      }
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/session-client-registry.js', () => ({
      injectSessionClientPromptWithResult
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-session-probe.js', () => ({
      isTmuxSessionAlive: () => true,
      resolveTmuxSessionWorkingDirectory: () => tmpDir
    }));

    await jest.unstable_mockModule('../../../../src/server/runtime/http-server/tmux-injection-history.js', () => ({
      appendTmuxInjectionHistoryEvent: () => Promise.resolve(true)
    }));

    const mod = await import('../../../../src/server/runtime/http-server/clock-runtime-hooks.js');
    await mod.registerClockRuntimeHooks();

    expect(typeof capturedHooks?.dispatchDueTask).toBe('function');
    const result = await capturedHooks.dispatchDueTask({
      sessionId: 'tmux:clock-stop-empty',
      tmuxSessionId: 'tmux:clock-stop-empty',
      task: { taskId: 'task-stop-empty' },
      injectText: '[Clock Reminder]'
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        cleanupSession: true,
        reason: 'clock_no_tasks'
      })
    );
    expect(injectSessionClientPromptWithResult).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
