import { describe, expect, it } from '@jest/globals';

import { findListeningPidsImpl, killPidBestEffortImpl } from '../../src/cli/server/port-utils.js';

describe('cli server port-utils', () => {
  it('killPidBestEffortImpl calls process.kill with SIGTERM/SIGKILL on non-windows', () => {
    const calls: Array<{ pid: number; signal: any }> = [];
    const processKill = ((pid: number, signal?: any) => {
      calls.push({ pid, signal });
      return true;
    }) as any;

    killPidBestEffortImpl({ pid: 123, force: false, isWindows: false, processKill });
    killPidBestEffortImpl({ pid: 456, force: true, isWindows: false, processKill });

    expect(calls).toEqual([
      { pid: 123, signal: 'SIGTERM' },
      { pid: 456, signal: 'SIGKILL' }
    ]);
  });

  it('killPidBestEffortImpl uses taskkill on windows', () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = ((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { stdout: '', stderr: '', status: 0 };
    }) as any;

    killPidBestEffortImpl({ pid: 789, force: false, isWindows: true, spawnSyncImpl });
    killPidBestEffortImpl({ pid: 789, force: true, isWindows: true, spawnSyncImpl });

    expect(spawnCalls[0]!.cmd).toBe('taskkill');
    expect(spawnCalls[0]!.args).toEqual(['/PID', '789', '/T']);
    expect(spawnCalls[1]!.args).toEqual(['/PID', '789', '/T', '/F']);
  });

  it('findListeningPidsImpl parses lsof output on non-windows', () => {
    const spawnSyncImpl = (() => ({ stdout: '123\n456\n', error: undefined })) as any;
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };

    const pids = findListeningPidsImpl({
      port: 5555,
      isWindows: false,
      spawnSyncImpl,
      logger,
      parseNetstatListeningPids: () => []
    });

    expect(pids).toEqual([123, 456]);
  });

  it('findListeningPidsImpl delegates to parseNetstatListeningPids on windows', () => {
    const spawnSyncImpl = (() => ({ stdout: 'NETSTAT', error: undefined })) as any;
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };
    const parseCalls: Array<{ stdout: string; port: number }> = [];
    const parseNetstatListeningPids = (stdout: string, port: number) => {
      parseCalls.push({ stdout, port });
      return [1001];
    };

    const pids = findListeningPidsImpl({
      port: 5520,
      isWindows: true,
      spawnSyncImpl,
      logger,
      parseNetstatListeningPids
    });

    expect(pids).toEqual([1001]);
    expect(parseCalls).toEqual([{ stdout: 'NETSTAT', port: 5520 }]);
  });
});
