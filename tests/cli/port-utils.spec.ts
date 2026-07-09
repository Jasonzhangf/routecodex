import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { describe, expect, it, jest } from '@jest/globals';

import {
  ensurePortAvailableImpl,
  findListeningPidsImpl,
  isServerHealthyQuickImpl,
  killPidBestEffortImpl,
  probeServerHealthQuickImpl
} from '../../src/cli/server/port-utils.js';
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

  it('findListeningPidsImpl trusts release snapshot cli.js pid cache entries', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-cli-pids-'));
    const pidDir = path.join(tmpHome, 'state', 'runtime-lifecycle', 'ports', '5555');
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, 'pid.cache'),
      JSON.stringify({ pid: process.pid, port: 5555, writtenAtMs: Date.now(), origin: 'snapshot' }),
      'utf8'
    );
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
            stdout: `${process.execPath} /Users/fanzhang/.rcc/install/current/dist/cli.js start --port 5555`,
            status: 0,
            error: undefined
          } as any;
        }
        if (cmd === 'lsof') {
          return { stdout: '', status: 1, error: undefined } as any;
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any
    });

    expect(pids).toEqual([process.pid]);
  });

  it('findListeningPidsImpl trusts global rcc dist index listeners', () => {
    const logger = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };

    const pids = findListeningPidsImpl({
      port: 5555,
      logger,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid === process.pid) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string, args: string[]) => {
        if (cmd === 'lsof') {
          return { stdout: `${process.pid}\n`, status: 0, error: undefined } as any;
        }
        if (cmd === 'ps') {
          return {
            stdout: `${process.execPath} /opt/homebrew/lib/node_modules/rcc/dist/index.js /opt/homebrew/lib/node_modules/rcc/config/modules.json`,
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
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
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
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        env: {},
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => [12345],
        killPidBestEffort: () => { killCalled = true; },
        isServerHealthyQuick: async () => false,
        exit: (() => { throw new Error('exit should not be called'); }) as any
      })).rejects.toThrow("Use 'rcc stop' or plain 'rcc start'");

      expect(fetchCalled).toBe(false);
      expect(killCalled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('ensurePortAvailableImpl does not send shutdown before confirming the port is occupied', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.listen({ host: '0.0.0.0', port: 0 }, () => resolve());
      probe.once('error', reject);
    });
    const address = probe.address();
    const freePort = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

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

    await ensurePortAvailableImpl({
      port: freePort,
      parentSpinner: spinner,
      opts: { restart: true },
      fetchImpl: (async () => {
        fetchCalled = true;
        return { ok: false };
      }) as any,
      sleep: async () => {},
      env: {},
      logger,
      createSpinner: async () => spinner,
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      isServerHealthyQuick: async () => false,
      exit: (() => { throw new Error('exit should not be called'); }) as any
    });

    expect(fetchCalled).toBe(false);
  });

  it('ensurePortAvailableImpl frees a managed RouteCodex port via HTTP shutdown before signals', async () => {
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
    const calls: string[] = [];
    const shutdownHeaders: Array<Record<string, string>> = [];
    let closed = false;
    const closeProbe = async () => {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    };

    try {
      await ensurePortAvailableImpl({
        port: occupiedPort,
        parentSpinner: spinner,
        opts: { restart: true },
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push(`fetch:${String(url)}`);
          if (String(url).endsWith('/shutdown')) {
            shutdownHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
            await closeProbe();
            return { ok: true, status: 200 };
          }
          return { ok: true, status: 200 };
        }) as any,
        sleep: async () => {},
        env: {},
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => [12345],
        killPidBestEffort: (pid, opts) => {
          calls.push(`kill:${pid}:${opts.force ? 'SIGKILL' : 'SIGTERM'}`);
        },
        isServerHealthyQuick: async () => true,
        exit: (() => { throw new Error('exit should not be called'); }) as any
      });

      expect(calls.some((call) => call.includes('/shutdown'))).toBe(true);
      expect(shutdownHeaders[0]).toEqual(expect.objectContaining({
        'x-routecodex-stop-caller-pid': expect.stringMatching(/^\d+$/),
        'x-routecodex-stop-caller-ts': expect.any(String),
        'x-routecodex-stop-caller-cwd': expect.any(String),
        'x-routecodex-stop-caller-cmd': expect.any(String),
      }));
      expect(calls.some((call) => call.startsWith('kill:'))).toBe(false);
    } finally {
      await closeProbe();
    }
  });

  it('ensurePortAvailableImpl falls back from HTTP shutdown to explicit managed PID signals', async () => {
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
    const calls: string[] = [];
    const shutdownHeaders: Array<Record<string, string>> = [];
    let closed = false;
    let managedPidAlive = true;
    const closeProbe = async () => {
      if (closed) {
        return;
      }
      closed = true;
      managedPidAlive = false;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    };

    try {
      await ensurePortAvailableImpl({
        port: occupiedPort,
        parentSpinner: spinner,
        opts: { restart: true },
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push(`fetch:${String(url)}`);
          if (String(url).endsWith('/shutdown')) {
            shutdownHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
          }
          return { ok: String(url).endsWith('/shutdown'), status: String(url).endsWith('/shutdown') ? 200 : 503 };
        }) as any,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        env: { ROUTECODEX_STOP_TIMEOUT_MS: '100' },
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => (managedPidAlive ? [12345] : []),
        killPidBestEffort: async (pid, opts) => {
          calls.push(`kill:${pid}:${opts.force ? 'SIGKILL' : 'SIGTERM'}`);
          if (!opts.force) {
            await closeProbe();
          }
        },
        isServerHealthyQuick: async () => true,
        exit: (() => { throw new Error('exit should not be called'); }) as any
      });

      const shutdownIndex = calls.findIndex((call) => call.includes('/shutdown'));
      const sigtermIndex = calls.findIndex((call) => call === 'kill:12345:SIGTERM');
      expect(shutdownIndex).toBeGreaterThanOrEqual(0);
      expect(shutdownHeaders[0]).toEqual(expect.objectContaining({
        'x-routecodex-stop-caller-pid': expect.stringMatching(/^\d+$/),
        'x-routecodex-stop-caller-ts': expect.any(String),
        'x-routecodex-stop-caller-cwd': expect.any(String),
        'x-routecodex-stop-caller-cmd': expect.any(String),
      }));
      expect(sigtermIndex).toBeGreaterThan(shutdownIndex);
      expect(calls).not.toContain('kill:12345:SIGKILL');
    } finally {
      await closeProbe();
    }
  });

  it('ensurePortAvailableImpl uses in-place restart and exits in build restart-only mode', async () => {
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
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);

    try {
      await expect(ensurePortAvailableImpl({
        port: occupiedPort,
        parentSpinner: spinner,
        opts: { restart: true },
        fetchImpl: (async () => {
          fetchCalled = true;
          return { ok: false };
        }) as any,
        sleep: async () => {},
        env: { ROUTECODEX_BUILD_RESTART_ONLY: '1' },
        logger,
        createSpinner: async () => spinner,
        findListeningPids: () => [12345],
        killPidBestEffort: () => {},
        isServerHealthyQuick: async () => true,
        exit: ((code: number) => { throw new Error(`exit:${code}`); }) as any
      })).rejects.toThrow('exit:0');

      expect(fetchCalled).toBe(false);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGUSR2');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      killSpy.mockRestore();
    }
  });

  it('isServerHealthyQuickImpl treats status=ok as healthy', async () => {
    const healthy = await isServerHealthyQuickImpl({
      port: 5520,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any
    });
    expect(healthy).toBe(true);
  });

  it('probeServerHealthQuickImpl classifies auth_error explicitly', async () => {
    const probe = await probeServerHealthQuickImpl({
      port: 5520,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":"unauthorized"}'
      })) as any
    });
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.kind).toBe('auth_error');
      expect(probe.status).toBe(401);
    }
  });
});
