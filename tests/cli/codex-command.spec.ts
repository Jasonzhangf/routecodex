import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

import { createCodexCommand } from '../../src/cli/commands/codex.js';

function createStubSpinner() {
  return {
    start: () => createStubSpinner(),
    succeed: () => {},
    fail: () => {},
    warn: () => {},
    info: () => {},
    stop: () => {},
    text: ''
  };
}

function createStubFs() {
  return {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('unexpected readFileSync');
    },
    statSync: () => ({ isFile: () => true, size: 1 } as any),
    mkdirSync: () => {},
    openSync: () => 1,
    closeSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {}
  } as any;
}

function createMockChildProcess() {
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  let closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;

  return {
    pid: 9527,
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === 'exit') exitHandler = cb as any;
      if (event === 'close') closeHandler = cb as any;
    }),
    kill: jest.fn(() => true),
    _triggerExit: (code: number | null, signal: NodeJS.Signals | null) => {
      exitHandler?.(code, signal);
    },
    _triggerClose: (code: number | null, signal: NodeJS.Signals | null) => {
      closeHandler?.(code, signal);
    }
  } as any;
}

function createDirectoryFs(existingDirs: string[]) {
  const normalized = new Set(existingDirs.map((entry) => entry.replace(/[\\/]+$/, '')));
  return {
    existsSync: (target: string) => normalized.has(String(target).replace(/[\\/]+$/, '')),
    readFileSync: () => {
      throw new Error('unexpected readFileSync');
    },
    statSync: (target: string) => ({
      isDirectory: () => normalized.has(String(target).replace(/[\\/]+$/, '')),
      isFile: () => !normalized.has(String(target).replace(/[\\/]+$/, ''))
    }),
    mkdirSync: () => {},
    openSync: () => 1,
    closeSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {}
  } as any;
}


function createConfigFs(port: number, apiKey = 'sk-config-key', host = '0.0.0.0') {
  const configPath = '/home/test/.rcc/config.json';
  const config = JSON.stringify({ httpserver: { port, apikey: apiKey, host } });
  return {
    existsSync: (target: string) => String(target) === configPath,
    readFileSync: (target: string) => {
      if (String(target) === configPath) {
        return config;
      }
      throw new Error(`unexpected readFileSync:${target}`);
    },
    statSync: () => ({ isFile: () => true, size: 1 } as any),
    mkdirSync: () => {},
    openSync: () => 1,
    closeSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {}
  } as any;
}

function createCodexProfileFs(profile = 'rcm') {
  const routeCodexConfigPath = '/home/test/.rcc/config.json';
  const codexConfigPath = '/home/test/.codex/config.toml';
  const routeCodexConfig = JSON.stringify({ httpserver: { port: 5520, apikey: 'sk-config-key', host: '127.0.0.1' } });
  const codexConfig = `[model_providers.${profile}]\nbase_url = "http://127.0.0.1:5520/v1"\n\n[profiles.${profile}]\nmodel_provider = "${profile}"\n`;
  return {
    existsSync: (target: string) => String(target) === routeCodexConfigPath || String(target) === codexConfigPath,
    readFileSync: (target: string) => {
      if (String(target) === routeCodexConfigPath) {
        return routeCodexConfig;
      }
      if (String(target) === codexConfigPath) {
        return codexConfig;
      }
      throw new Error(`unexpected readFileSync:${target}`);
    },
    statSync: () => ({ isFile: () => true, size: 1 } as any),
    mkdirSync: () => {},
    openSync: () => 1,
    closeSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {}
  } as any;
}

function findTmuxLaunchCall(
  tmuxCalls: Array<{ command: string; args: string[] }>,
  target?: string
): { command: string; args: string[] } | undefined {
  return tmuxCalls.find((call) => {
    if (call.command !== 'tmux') {
      return false;
    }
    if (call.args[0] === 'respawn-pane') {
      return !target || call.args.includes(target);
    }
    if (call.args[0] === 'send-keys' && call.args.includes('-l')) {
      return !target || call.args.includes(target);
    }
    return false;
  });
}

function extractTmuxLaunchShellCommand(call: { command: string; args: string[] } | undefined): string {
  if (!call) {
    return '';
  }
  if (call.args[0] === 'respawn-pane') {
    return String(call.args[4] || '');
  }
  if (call.args[0] === 'send-keys' && call.args.includes('-l')) {
    return String(call.args[5] || '');
  }
  return '';
}

describe('cli codex command', () => {
  describe('launcher grace period', () => {
    it('waits for grace period before exiting after close event', async () => {
      const infos: string[] = [];
      const exitCodes: number[] = [];
      const program = new Command();
      const childProcess = createMockChildProcess();
      const setTimeoutCalls: number[] = [];
      const originalSetTimeout = global.setTimeout;

      // Mock setTimeout to track delays
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => {
        setTimeoutCalls.push(delay);
        if (typeof fn === 'function') {
          // Execute immediately for test
          fn();
        }
        return 0 as any;
      }) as any);

      createCodexCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5555,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: (msg) => infos.push(String(msg)), warning: () => {}, success: () => {}, error: () => {} },
        env: { ROUTECODEX_HTTP_APIKEY: 'sk-test-key' },
        rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
        fsImpl: createStubFs(),
        homedir: () => '/home/test',
        cwd: () => '/home/test',
        sleep: async () => {},
        fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
        spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
        spawn: () => childProcess,
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveServerEntryPath: () => '/tmp/index.js',
        waitForever: async () => {
          childProcess._triggerExit(0, null);
          childProcess._triggerClose(0, null);
          await new Promise((resolve) => originalSetTimeout(resolve, 10));
        },
        exit: (code) => {
          exitCodes.push(Number(code));
          return undefined as never;
        }
      });

      await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

      // Verify grace period was scheduled (default 2000ms)
      expect(setTimeoutCalls.some(d => d === 2000)).toBe(true);
      expect(infos.some((line) => line.includes('[client-exit] Waiting 2000ms for output to flush'))).toBe(true);
      expect(exitCodes).toContain(0);

      jest.restoreAllMocks();
    });

    it('respects ROUTECODEX_LAUNCHER_EXIT_GRACE_PERIOD_MS env variable', async () => {
      const infos: string[] = [];
      const program = new Command();
      const childProcess = createMockChildProcess();
      const setTimeoutCalls: number[] = [];
      const originalSetTimeout = global.setTimeout;

      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => {
        setTimeoutCalls.push(delay);
        if (typeof fn === 'function') fn();
        return 0 as any;
      }) as any);

      createCodexCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5555,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: (msg) => infos.push(String(msg)), warning: () => {}, success: () => {}, error: () => {} },
        env: {
          ROUTECODEX_HTTP_APIKEY: 'sk-test-key',
          ROUTECODEX_LAUNCHER_EXIT_GRACE_PERIOD_MS: '5000'
        },
        rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
        fsImpl: createStubFs(),
        homedir: () => '/home/test',
        cwd: () => '/home/test',
        sleep: async () => {},
        fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
        spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
        spawn: () => childProcess,
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveServerEntryPath: () => '/tmp/index.js',
        waitForever: async () => {
          childProcess._triggerExit(0, null);
          childProcess._triggerClose(0, null);
          await new Promise((resolve) => originalSetTimeout(resolve, 10));
        },
        exit: () => undefined as never
      });

      await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

      expect(setTimeoutCalls.some(d => d === 5000)).toBe(true);
      expect(infos.some((line) => line.includes('Waiting 5000ms'))).toBe(true);

      jest.restoreAllMocks();
    });

    it('exits immediately when grace period is set to 0', async () => {
      const infos: string[] = [];
      const exitCodes: number[] = [];
      const program = new Command();
      const childProcess = createMockChildProcess();
      const setTimeoutCalls: number[] = [];

      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => {
        setTimeoutCalls.push(delay);
        return 0 as any;
      }) as any);

      createCodexCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5555,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: (msg) => infos.push(String(msg)), warning: () => {}, success: () => {}, error: () => {} },
        env: {
          ROUTECODEX_HTTP_APIKEY: 'sk-test-key',
          ROUTECODEX_LAUNCHER_EXIT_GRACE_PERIOD_MS: '0'
        },
        rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
        fsImpl: createStubFs(),
        homedir: () => '/home/test',
        cwd: () => '/home/test',
        sleep: async () => {},
        fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
        spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
        spawn: () => childProcess,
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveServerEntryPath: () => '/tmp/index.js',
        waitForever: async () => {
          childProcess._triggerExit(0, null);
          childProcess._triggerClose(0, null);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
        exit: (code) => {
          exitCodes.push(Number(code));
          return undefined as never;
        }
      });

      await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

      // No setTimeout should be called when grace period is 0
      expect(setTimeoutCalls.length).toBe(0);
      expect(infos.some((line) => line.includes('Waiting'))).toBe(false);
      expect(exitCodes).toContain(0);

      jest.restoreAllMocks();
    });
  });

  it('prints codex exit summary after child close', async () => {
    const infos: string[] = [];
    const exitCodes: number[] = [];
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: (msg) => infos.push(String(msg)), warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: () =>
        ({
          pid: 9527,
          on: (event: string, cb: (...args: any[]) => void) => {
            if (event === 'exit') {
              onExit = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
            }
            if (event === 'close') {
              onClose = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
            }
          },
          kill: () => true
        }) as any,
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {
        onExit?.(17, null);
        onClose?.(17, null);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      exit: (code) => {
        exitCodes.push(Number(code));
        return undefined as never;
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], {
      from: 'node'
    });

    expect(infos.some((line) => line.includes('[client-exit] Codex exited (code=17, signal=none)'))).toBe(true);
    expect(exitCodes).toContain(17);
  });

  it('does not forward SIGTERM to codex child by default', async () => {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const killSignals: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: () => ({
        pid: process.pid,
        on: () => {},
        kill: (signal: NodeJS.Signals) => {
          killSignals.push(String(signal));
          return true;
        }
      }) as any,
      onSignal: (signal, cb) => {
        signalHandlers.set(signal, cb);
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {
        const handler = signalHandlers.get('SIGTERM');
        handler?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      exit: () => undefined as never
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(killSignals).toEqual([]);
  });

  it('does not kill codex child on SIGTERM when orphan-reap is explicitly disabled', async () => {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const killSignals: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_LAUNCHER_REAP_CHILD_ON_SHUTDOWN: '0'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: () => ({
        pid: process.pid,
        on: () => {},
        kill: (signal: NodeJS.Signals) => {
          killSignals.push(String(signal));
          return true;
        }
      }) as any,
      onSignal: (signal, cb) => {
        signalHandlers.set(signal, cb);
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {
        const handler = signalHandlers.get('SIGTERM');
        handler?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      exit: () => undefined as never
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(killSignals).toEqual([]);
  });

  it('does not forward SIGTERM even when legacy forward env switch is enabled', async () => {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const killSignals: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_LAUNCHER_FORWARD_SIGTERM: '1'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready', ok: true }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: () => ({
        pid: process.pid,
        on: () => {},
        kill: (signal: NodeJS.Signals) => {
          killSignals.push(String(signal));
          return true;
        }
      }) as any,
      onSignal: (signal, cb) => {
        signalHandlers.set(signal, cb);
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {
        const handler = signalHandlers.get('SIGTERM');
        handler?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      exit: () => undefined as never
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(killSignals).toEqual([]);
  });

  it('uses explicit --cwd as launch working directory', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();
    const explicitCwd = '/home/test/workspace-explicit';

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy', '--cwd', explicitCwd],
      fsImpl: createDirectoryFs([explicitCwd]),
      homedir: () => '/home/test',
      cwd: () => '/home/test/default',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy', '--cwd', explicitCwd], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].options?.cwd).toBe(explicitCwd);
    expect(spawnCalls[0].options?.env?.RCC_WORKDIR).toBeUndefined();
    expect(spawnCalls[0].options?.env?.ROUTECODEX_WORKDIR).toBeUndefined();
  });

  it('fails fast when explicit --cwd does not exist', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const errors: string[] = [];
    const program = new Command();
    const invalidCwd = '/home/test/missing-workspace';

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(String(msg)) },
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy', '--cwd', invalidCwd],
      fsImpl: createDirectoryFs([]),
      homedir: () => '/home/test',
      cwd: () => '/home/test/default',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy', '--cwd', invalidCwd], { from: 'node' })
    ).rejects.toThrow('exit:1');

    expect(spawnCalls).toHaveLength(0);
    expect(errors.some((line) => line.includes('Invalid --cwd: path does not exist'))).toBe(true);
  });

  it('falls back to homedir when current cwd is unavailable (uv_cwd)', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();
    const fallbackHome = '/home/test';

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createDirectoryFs([fallbackHome]),
      homedir: () => fallbackHome,
      cwd: () => {
        throw new Error('EPERM: operation not permitted, uv_cwd');
      },
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].options?.cwd).toBe(fallbackHome);
  });

  it('launches codex without proxy env vars in tmux-only mode', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy', '--model', 'gpt-5.2-codex', '--', '--foo', 'bar'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy', '--model', 'gpt-5.2-codex', '--', '--foo', 'bar'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].args).toEqual(['--model', 'gpt-5.2-codex', '--foo', 'bar']);
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBeUndefined();
    expect(spawnCalls[0].options?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it('auto-applies RouteCodex codex profile when ~/.codex/config.toml contains rcm', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--model', 'gpt-5.2-codex'],
      fsImpl: createCodexProfileFs('rcm'),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'codex', '--model', 'gpt-5.2-codex'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].args).toEqual(['--model', 'gpt-5.2-codex', '--profile', 'rcm']);
  });


  it('does not probe server readiness in tmux-only mode when config exists', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const fetchCalls: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex'],
      fsImpl: createConfigFs(7788),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        throw new Error('fetch should not be called in tmux-only mode');
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex'], { from: 'node' });

    expect(fetchCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

  it('does not probe server readiness in tmux-only mode even when --url is provided', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const probeUrls: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex'],
      fsImpl: createConfigFs(5520, 'sk-config-key', '0.0.0.0'),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        probeUrls.push(String(url));
        throw new Error('fetch should not be called in tmux-only mode');
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex'], { from: 'node' });

    expect(probeUrls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

  it('does not probe server readiness in tmux-only mode when --port is provided', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const fetchCalls: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--port', '8899'],
      fsImpl: createConfigFs(7788),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        throw new Error('fetch should not be called in tmux-only mode');
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--port', '8899'], { from: 'node' });

    expect(fetchCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

  it('passes downstream -p profile args without proxy env in tmux-only mode', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', 'dangerously-bypass-approvals-and-sandbox', '-p', 'rcm', '--port', '5520'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ready' }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'codex', 'dangerously-bypass-approvals-and-sandbox', '-p', 'rcm', '--port', '5520'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].args).toEqual(['dangerously-bypass-approvals-and-sandbox', '-p', 'rcm']);
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBeUndefined();
  });

  it('passes resume subcommand profile args through to codex', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--profile', 'tcm'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--profile', 'tcm'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].args).toEqual(['--profile', 'tcm', 'resume', '--dangerously-bypass-approvals-and-sandbox']);
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBeUndefined();
  });


  it('does not probe server readiness in tmux-only mode when --url is explicit', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const fetchCalls: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_SESSION_RECLAIM_REQUIRED: '0' },
      rawArgv: ['codex', '--url', 'http://localhost:5520'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        throw new Error('fetch should not be called in tmux-only mode');
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520'], { from: 'node' });

    expect(fetchCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

  it('warns when tmux is missing in tmux-only mode', async () => {
    const warnings: string[] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: (msg) => warnings.push(msg), success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ status: 'ready' }) })) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].options?.env?.RCC_SESSION_ADVANCED_ENABLED).toBeUndefined();
    expect(warnings.some((line) => line.includes('tmux not found'))).toBe(true);
  });

  it('does not attempt session daemon registration in tmux-only mode', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const errors: string[] = [];
    let registerCalls = 0;
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      env: {
        ROUTECODEX_SESSION_RECLAIM_REQUIRED: '1',
        TMUX: '/tmp/tmux,123,0',
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.includes('/daemon/session-client/register')) {
          registerCalls += 1;
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'display-message') {
          return { status: 0, stdout: 's-main:0.0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes') {
          return { status: 0, stdout: 'zsh\t/home/test\n', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(registerCalls).toBe(0);
    expect(errors.some((line) => line.includes('session client registration failed'))).toBe(false);
  });

  it('skips session daemon heartbeat in tmux-only mode', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    let registerCalls = 0;
    let heartbeatCalls = 0;
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        TMUX: '/tmp/tmux,123,0',
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.includes('/daemon/session-client/register')) {
          registerCalls += 1;
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
        }
        if (url.includes('/daemon/session-client/heartbeat')) {
          heartbeatCalls += 1;
          return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not_found' }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'display-message') {
          return { status: 0, stdout: 's-main:0.0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes') {
          return { status: 0, stdout: 'zsh\t/home/test\n', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { pid: 1234, on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(registerCalls).toBe(0);
    expect(heartbeatCalls).toBe(0);
  });

  it('auto-manages tmux session when user is not already in tmux', async () => {
    const warnings: string[] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: (msg) => warnings.push(msg), success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'kill-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('tmux');
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['attach-session']));
    expect(spawnCalls[0].options?.env?.TMUX).toBeUndefined();
    expect(spawnCalls[0].options?.env?.TMUX_PANE).toBeUndefined();
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'respawn-pane' || call.args[0] === 'send-keys')).toBe(true);
    expect(warnings.some((line) => line.includes('not running inside tmux'))).toBe(false);
  });

  it('fails fast with a clear error when managed tmux attach has no interactive TTY', async () => {
    const errors: string[] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(String(msg)) },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      isInteractiveTerminal: () => false,
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' })
    ).rejects.toThrow('exit:1');

    expect(spawnCalls).toHaveLength(0);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(errors.some((line) => line.includes('interactive terminal (TTY)'))).toBe(true);
  });

  it('generates unique cwd-basename session ids and retries on collision', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const hasSessionTargets: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-clock',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          const target = String(args[args.length - 1] || '');
          hasSessionTargets.push(target);
          return { status: hasSessionTargets.length === 1 ? 0 : 1, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    const newSessionCall = tmuxCalls.find((call) => call.args[0] === 'new-session');
    expect(newSessionCall).toBeDefined();
    const sessionNameIndex = newSessionCall!.args.indexOf('-s') + 1;
    const sessionName = sessionNameIndex > 0 ? String(newSessionCall!.args[sessionNameIndex]) : '';
    expect(sessionName).toBe('rcc-workspace-clock-2');
    expect(hasSessionTargets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hasSessionTargets).size).toBeGreaterThanOrEqual(2);
    expect(hasSessionTargets).toEqual(expect.arrayContaining(['rcc-workspace-clock', 'rcc-workspace-clock-2']));
  });

  it('requests managed tmux session self-exit on codex close without kill-session', async () => {
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'respawn-pane') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return {
          pid: 4242,
          on: (event: string, cb: (...eventArgs: any[]) => void) => {
            if (event === 'exit') {
              onExit = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
            }
            if (event === 'close') {
              onClose = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
            }
          },
          kill: () => true
        } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {
        onExit?.(0, null);
        onClose?.(0, null);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      exit: () => undefined as never
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('tmux');
    expect(tmuxCalls.some((call) => call.args[0] === 'kill-session')).toBe(false);
    const launchCall = findTmuxLaunchCall(tmuxCalls);
    expect(launchCall).toBeDefined();
    expect(extractTmuxLaunchShellCommand(launchCall)).not.toContain('kill-session -t');
    expect(
      tmuxCalls.some(
        (call) => call.args[0] === 'send-keys' && call.args.includes('-l') && call.args.includes('exit')
      )
    ).toBe(true);
  });

  it('does not reuse orphan managed tmux session', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const infos: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-a',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'display-message') {
          return { status: 1, stdout: '', stderr: 'not in tmux' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'kill-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('tmux');
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['attach-session']));
    expect(tmuxCalls.some((call) => call.args[0] === 'list-sessions')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    const launchCall = findTmuxLaunchCall(tmuxCalls);
    expect(launchCall).toBeDefined();
    const shellCommand = extractTmuxLaunchShellCommand(launchCall);
    expect(shellCommand).toContain("cd -- '/home/test/workspace-a'");
    expect(tmuxCalls.some((call) => call.args.some((arg) => String(arg).includes('workspace-a')))).toBe(true);
    expect(infos.some((line) => line.includes('reused existing managed tmux session'))).toBe(false);
  });

  it('creates new managed tmux session even when an orphan session exists', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const infos: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-b',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'display-message') {
          return { status: 1, stdout: '', stderr: 'not in tmux' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'kill-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-sessions')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(tmuxCalls.some((call) => call.args.some((arg) => String(arg).includes('workspace-b')))).toBe(true);
    expect(infos.some((line) => line.includes('reused existing managed tmux session'))).toBe(false);
  });

  it('does not reuse claude orphan tmux session for codex launcher', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const infos: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-codex',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'display-message') {
          return { status: 1, stdout: '', stderr: 'not in tmux' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'kill-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-sessions')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes')).toBe(false);
    expect(tmuxCalls.some((call) => call.args.some((arg) => String(arg).includes('workspace-codex')))).toBe(true);
    expect(infos.some((line) => line.includes('reused existing managed tmux session'))).toBe(false);
  });


  it("does not reuse orphan session when pane command is non-shell", async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: "node",
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ["codex", "--url", "http://localhost:5520/proxy"],
      fsImpl: createStubFs(),
      homedir: () => "/home/test",
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith("/ready") || url.endsWith("/health")) {
          return { ok: true, status: 200, json: async () => ({ status: "ok", ready: true }) } as any;
        }
        if (url.includes("/daemon/session-client/register")) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== "tmux") {
          return { status: 1, stdout: "", stderr: "unknown command" } as any;
        }
        if (args[0] === "-V") {
          return { status: 0, stdout: "tmux 3.4", stderr: "" } as any;
        }
        if (args[0] === "display-message") {
          return { status: 1, stdout: "", stderr: "not in tmux" } as any;
        }
        if (args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "missing" } as any;
        }
        if (args[0] === "new-session") {
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "send-keys") {
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        return { status: 0, stdout: "", stderr: "" } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => "/tmp/modules.json",
      resolveServerEntryPath: () => "/tmp/index.js",
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(["node", "routecodex", "codex", "--url", "http://localhost:5520/proxy"], { from: "node" });

    expect(spawnCalls).toHaveLength(1);
    expect(tmuxCalls.some((call) => call.args[0] === "new-session")).toBe(true);
  });

  it('when already in tmux, codex still starts a managed tmux session', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        TMUX: '/tmp/tmux,123,0',
        ROUTECODEX_HTTP_APIKEY: 'sk-test-key'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-inside',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/session-client/register')) {
          return { ok: false, status: 503, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== 'tmux') {
          return { status: 1, stdout: '', stderr: 'unknown command' } as any;
        }
        if (args[0] === '-V') {
          return { status: 0, stdout: 'tmux 3.4', stderr: '' } as any;
        }
        if (args[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'missing' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'send-keys') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        if (args[0] === 'kill-session') {
          return { status: 0, stdout: '', stderr: '' } as any;
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('tmux');
    expect(tmuxCalls.some((call) => call.args[0] === 'display-message')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes')).toBe(false);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
  });

  it("injects tmux-scoped api keys in tmux-only mode", async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: "node",
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_HTTP_APIKEY: 'sk-base-key' },
      rawArgv: ["codex", "--url", "http://localhost:5520/proxy"],
      fsImpl: createStubFs(),
      homedir: () => "/home/test",
      cwd: () => "/home/test/workspace-clock",
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith("/ready") || url.endsWith("/health")) {
          return { ok: true, status: 200, json: async () => ({ status: "ok", ready: true }) } as any;
        }
        if (url.includes("/daemon/session-client/register")) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: (command: string, args: string[]) => {
        tmuxCalls.push({ command, args });
        if (command !== "tmux") {
          return { status: 1, stdout: "", stderr: "unknown command" } as any;
        }
        if (args[0] === "-V") {
          return { status: 0, stdout: "tmux 3.4", stderr: "" } as any;
        }
        if (args[0] === "has-session") {
          return { status: 1, stdout: "", stderr: "missing" } as any;
        }
        if (args[0] === "new-session") {
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "send-keys") {
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "kill-session") {
          return { status: 0, stdout: "", stderr: "" } as any;
        }
        return { status: 0, stdout: "", stderr: "" } as any;
      },
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true } as any;
      },
      getModulesConfigPath: () => "/tmp/modules.json",
      resolveServerEntryPath: () => "/tmp/index.js",
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(["node", "routecodex", "codex", "--url", "http://localhost:5520/proxy"], { from: "node" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("tmux");
    const launchCall = findTmuxLaunchCall(tmuxCalls);
    expect(launchCall).toBeDefined();
    const shellCommand = extractTmuxLaunchShellCommand(launchCall);
    expect(shellCommand).toContain("cd -- '/home/test/workspace-clock'");
    expect(shellCommand).toContain("ROUTECODEX_HTTP_APIKEY=sk-base-key::rcc-session:rcc-workspace-clock");
    expect(shellCommand).toContain("RCC_HTTP_APIKEY=sk-base-key::rcc-session:rcc-workspace-clock");
    expect(shellCommand).toContain("OPENAI_API_KEY=sk-base-key::rcc-session:rcc-workspace-clock");
    expect(shellCommand).toContain("ANTHROPIC_AUTH_TOKEN=sk-base-key::rcc-session:rcc-workspace-clock");
    expect(shellCommand).toContain("[routecodex][self-heal]");
    expect(shellCommand).toContain("__rcc_max=");
    expect(shellCommand).toContain("while true; do");
    expect(shellCommand).not.toContain("while true; do;");
  });

  it('does not auto-start server when routecodex is unavailable', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    let readyChecks = 0;

    const program = new Command();
    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_SESSION_RECLAIM_REQUIRED: '0' },
      rawArgv: ['codex', '--', '--help'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          readyChecks += 1;
          if (readyChecks <= 2) {
            return { ok: false, status: 503, json: async () => ({}) } as any;
          }
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'tmux not found' }) as any,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { on: () => {}, kill: () => true, unref: () => {} } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--', '--help'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

});
