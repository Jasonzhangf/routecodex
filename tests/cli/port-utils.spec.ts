import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { describe, expect, it } from '@jest/globals';

import { ensurePortAvailableImpl, findListeningPidsImpl, isServerHealthyQuickImpl, killPidBestEffortImpl } from '../../src/cli/server/port-utils.js';
import { flushProcessLifecycleLogQueue } from '../../src/utils/process-lifecycle-logger.js';

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

  it('findListeningPidsImpl reads managed pid file on non-windows', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-pids-'));
    const pidFile = path.join(tmpHome, 'server-5555.pid');
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };

    const pids = findListeningPidsImpl({
      port: 5555,
      routeCodexHomeDir: tmpHome,
      logger,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid === process.pid) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string, args: string[]) => {
        if (cmd === 'ps') {
          return {
            stdout: `${process.execPath} /Users/fanzhang/Documents/github/routecodex/dist/index.js config/modules.json`,
            status: 0,
            error: undefined
          } as any;
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any
    });

    expect(pids).toEqual([process.pid]);
  });

  it('findListeningPidsImpl returns empty when pid file command is not trusted', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-pids-untrusted-'));
    fs.writeFileSync(path.join(tmpHome, 'server-5520.pid'), '12345', 'utf8');
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };

    const pids = findListeningPidsImpl({
      port: 5520,
      routeCodexHomeDir: tmpHome,
      logger,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid === 12345) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string) => {
        if (cmd === 'ps') {
          return { stdout: 'node /tmp/not-routecodex.js', status: 0, error: undefined } as any;
        }
        throw new Error('unexpected command');
      }) as any
    });

    expect(pids).toEqual([]);
  });

  it('writes lifecycle kill_attempt entries', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-port-utils-'));
    const logPath = path.join(tempDir, 'process-lifecycle.jsonl');
    const prevPath = process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG;
    const prevConsole = process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE;

    process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG = logPath;
    process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE = '0';

    try {
      const processKill = (() => true) as any;
      killPidBestEffortImpl({ pid: 321, force: false, isWindows: false, processKill });
      await flushProcessLifecycleLogQueue();

      const lines = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const attempts = lines.filter((entry) => entry.event === 'kill_attempt');
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(
        attempts.some((entry) => (entry.details as Record<string, unknown>)?.result === 'attempt')
      ).toBe(true);
      expect(
        attempts.some((entry) => (entry.details as Record<string, unknown>)?.result === 'success')
      ).toBe(true);
    } finally {
      if (prevPath === undefined) {
        delete process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG;
      } else {
        process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG = prevPath;
      }
      if (prevConsole === undefined) {
        delete process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE;
      } else {
        process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE = prevConsole;
      }
    }
  });

  it('ensurePortAvailableImpl fails on unmanaged occupied port', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.listen({ host: '0.0.0.0', port: 0 }, () => resolve());
      probe.once('error', reject);
    });
    const address = probe.address();
    const occupiedPort = typeof address === 'object' && address ? address.port : 0;

    const spinner = {
      start: () => spinner,
      succeed: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      stop: () => {},
      text: ''
    };
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };

    try {
      await expect(ensurePortAvailableImpl({
        port: occupiedPort,
        parentSpinner: spinner,
        opts: { restart: true },
        fetchImpl: (async () => ({ ok: false })) as any,
        sleep: async () => {},
        env: {},
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        isServerHealthyQuick: async () => false,
        exit: (() => { throw new Error('exit should not be called'); }) as any
      })).rejects.toThrow('unmanaged process');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('ensurePortAvailableImpl does not trigger shutdown/kill when restart is false', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.listen({ host: '0.0.0.0', port: 0 }, () => resolve());
      probe.once('error', reject);
    });
    const address = probe.address();
    const occupiedPort = typeof address === 'object' && address ? address.port : 0;

    const spinner = {
      start: () => spinner,
      succeed: () => {},
      fail: () => {},
      warn: () => {},
      info: () => {},
      stop: () => {},
      text: ''
    };
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };
    let fetchCalled = false;
    let killCalled = false;

    try {
      await expect(ensurePortAvailableImpl({
        port: occupiedPort,
        parentSpinner: spinner,
        opts: { restart: false },
        fetchImpl: (async () => {
          fetchCalled = true;
          return { ok: false };
        }) as any,
        sleep: async () => {},
        env: {},
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => [12345],
        killPidBestEffort: () => { killCalled = true; },
        isServerHealthyQuick: async () => false,
        exit: (() => { throw new Error('exit should not be called'); }) as any
      })).rejects.toThrow("Use 'rcc stop' or 'rcc start --restart'");

      expect(fetchCalled).toBe(false);
      expect(killCalled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('isServerHealthyQuickImpl treats status=ok as healthy', async () => {
    const healthy = await isServerHealthyQuickImpl({
      port: 5520,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ status: 'ok' })
      })) as any
    });
    expect(healthy).toBe(true);
  });
});
