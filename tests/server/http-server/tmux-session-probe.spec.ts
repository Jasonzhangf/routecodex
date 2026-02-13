import { describe, expect, it, jest } from '@jest/globals';

describe('tmux-session-probe lifecycle logging', () => {
  it('logs attempt and success when managed tmux session is killed', async () => {
    jest.resetModules();
    const logProcessLifecycle = jest.fn();
    const spawnSyncMock = jest.fn((command: string, args: string[]) => {
      if (command !== 'tmux') {
        return { status: 1, stdout: '', stderr: 'unexpected command' } as any;
      }
      if (args[0] === '-V') {
        return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
      }
      if (args[0] === 'has-session') {
        return { status: 0, stdout: '', stderr: '' } as any;
      }
      if (args[0] === 'kill-session') {
        return { status: 0, stdout: '', stderr: '' } as any;
      }
      return { status: 1, stdout: '', stderr: 'unsupported' } as any;
    });

    await jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: spawnSyncMock
    }));
    await jest.unstable_mockModule('../../../src/utils/process-lifecycle-logger.js', () => ({
      logProcessLifecycle
    }));

    const probe = await import('../../../src/server/runtime/http-server/tmux-session-probe.js');
    const ok = probe.killManagedTmuxSession('rcc_codex_test:0.0');

    expect(ok).toBe(true);
    expect(logProcessLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'kill_attempt',
        source: 'http.clock-managed-tmux-reaper',
        details: expect.objectContaining({ tmuxSessionId: 'rcc_codex_test', result: 'attempt' })
      })
    );
    expect(logProcessLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'kill_attempt',
        source: 'http.clock-managed-tmux-reaper',
        details: expect.objectContaining({ tmuxSessionId: 'rcc_codex_test', result: 'success', reason: 'session_killed' })
      })
    );
  });

  it('logs skipped for unmanaged tmux session target', async () => {
    jest.resetModules();
    const logProcessLifecycle = jest.fn();
    const spawnSyncMock = jest.fn();

    await jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: spawnSyncMock
    }));
    await jest.unstable_mockModule('../../../src/utils/process-lifecycle-logger.js', () => ({
      logProcessLifecycle
    }));

    const probe = await import('../../../src/server/runtime/http-server/tmux-session-probe.js');
    const ok = probe.killManagedTmuxSession('custom_shared_session');

    expect(ok).toBe(false);
    expect(logProcessLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'kill_attempt',
        source: 'http.clock-managed-tmux-reaper',
        details: expect.objectContaining({ tmuxSessionId: 'custom_shared_session', result: 'skipped', reason: 'unmanaged_session' })
      })
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
