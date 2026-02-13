import { describe, expect, it, jest } from '@jest/globals';

describe('managed-process-probe lifecycle logging', () => {
  it('logs attempt and success when managed pid exits after SIGTERM', async () => {
    jest.resetModules();
    const logProcessLifecycle = jest.fn();
    const spawnSyncMock = jest.fn(() => ({ status: 0, stdout: '/usr/local/bin/codex --model gpt', stderr: '' }));

    await jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: spawnSyncMock
    }));
    await jest.unstable_mockModule('../../../src/utils/process-lifecycle-logger.js', () => ({
      logProcessLifecycle
    }));

    let zeroProbeCount = 0;
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== 43210) {
        throw Object.assign(new Error('unexpected kill'), { code: 'ESRCH' });
      }
      if (signal === 0) {
        zeroProbeCount += 1;
        if (zeroProbeCount === 1) {
          return true as any;
        }
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM') {
        return true as any;
      }
      throw Object.assign(new Error('unexpected signal'), { code: 'ESRCH' });
    }) as any);

    try {
      const probe = await import('../../../src/server/runtime/http-server/managed-process-probe.js');
      const ok = probe.terminateManagedClientProcess({
        daemonId: 'clockd_success',
        pid: 43210,
        commandHint: 'codex',
        clientType: 'codex'
      });

      expect(ok).toBe(true);
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'kill_attempt',
          source: 'http.clock-managed-client-reaper',
          details: expect.objectContaining({ targetPid: 43210, signal: 'SIGTERM', result: 'attempt' })
        })
      );
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'kill_attempt',
          source: 'http.clock-managed-client-reaper',
          details: expect.objectContaining({ targetPid: 43210, signal: 'SIGTERM', result: 'success', reason: 'signaled' })
        })
      );
      expect(logProcessLifecycle).not.toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ targetPid: 43210, signal: 'SIGKILL', result: 'attempt' })
        })
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it('escalates to SIGKILL when process survives SIGTERM', async () => {
    jest.resetModules();
    const logProcessLifecycle = jest.fn();
    const spawnSyncMock = jest.fn(() => ({ status: 0, stdout: '/usr/local/bin/claude --proxy', stderr: '' }));

    await jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: spawnSyncMock
    }));
    await jest.unstable_mockModule('../../../src/utils/process-lifecycle-logger.js', () => ({
      logProcessLifecycle
    }));

    let zeroProbeCount = 0;
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== 65432) {
        throw Object.assign(new Error('unexpected kill'), { code: 'ESRCH' });
      }
      if (signal === 0) {
        zeroProbeCount += 1;
        if (zeroProbeCount <= 2) {
          return true as any;
        }
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return true as any;
      }
      throw Object.assign(new Error('unexpected signal'), { code: 'ESRCH' });
    }) as any);

    try {
      const probe = await import('../../../src/server/runtime/http-server/managed-process-probe.js');
      const ok = probe.terminateManagedClientProcess({
        daemonId: 'clockd_escalate',
        pid: 65432,
        commandHint: 'claude',
        clientType: 'claude'
      });

      expect(ok).toBe(true);
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ targetPid: 65432, signal: 'SIGTERM', result: 'failed', reason: 'alive_after_term' })
        })
      );
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ targetPid: 65432, signal: 'SIGKILL', result: 'attempt', reason: 'term_escalation' })
        })
      );
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ targetPid: 65432, signal: 'SIGKILL', result: 'success', reason: 'signaled' })
        })
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it('logs skipped when command does not match managed hint', async () => {
    jest.resetModules();
    const logProcessLifecycle = jest.fn();
    const spawnSyncMock = jest.fn(() => ({ status: 0, stdout: '/usr/bin/python3 unrelated-script.py', stderr: '' }));

    await jest.unstable_mockModule('node:child_process', () => ({
      spawnSync: spawnSyncMock
    }));
    await jest.unstable_mockModule('../../../src/utils/process-lifecycle-logger.js', () => ({
      logProcessLifecycle
    }));

    const killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 54321 && signal === 0) {
        return true as any;
      }
      throw Object.assign(new Error('unexpected kill'), { code: 'ESRCH' });
    }) as any);

    try {
      const probe = await import('../../../src/server/runtime/http-server/managed-process-probe.js');
      const ok = probe.terminateManagedClientProcess({
        daemonId: 'clockd_skip',
        pid: 54321,
        commandHint: 'codex',
        clientType: 'codex'
      });

      expect(ok).toBe(false);
      expect(logProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'kill_attempt',
          source: 'http.clock-managed-client-reaper',
          details: expect.objectContaining({ targetPid: 54321, result: 'skipped', reason: 'command_mismatch' })
        })
      );
      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
    }
  });
});
