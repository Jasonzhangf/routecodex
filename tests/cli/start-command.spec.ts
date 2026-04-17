import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createStartCommand } from '../../src/cli/commands/start.js';
import { registerStartCommand } from '../../src/cli/register/start-command.js';

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

describe('cli start command', () => {
  it('managed restart retries early-exit child without exiting parent process', async () => {
    const program = new Command();
    const infoLogs: string[] = [];
    let spawnCount = 0;
    let activeGeneration = 0;

    type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;

    class FakeChildProc {
      pid: number;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      stdout: null = null;
      stderr: null = null;
      private readonly handlers = new Map<string, ExitHandler[]>();

      constructor(pid: number) {
        this.pid = pid;
      }

      on(event: string, handler: ExitHandler): this {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
      }

      once(event: string, handler: ExitHandler): this {
        const wrapped: ExitHandler = (code, signal) => {
          this.off(event, wrapped);
          handler(code, signal);
        };
        return this.on(event, wrapped);
      }

      off(event: string, handler: ExitHandler): this {
        const list = this.handlers.get(event) ?? [];
        this.handlers.set(event, list.filter((item) => item !== handler));
        return this;
      }

      kill(signal?: NodeJS.Signals): boolean {
        this.emitExit(this.exitCode, signal ?? 'SIGTERM');
        return true;
      }

      emitExit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exitCode = code;
        this.signalCode = signal;
        const listeners = [...(this.handlers.get('exit') ?? [])];
        for (const listener of listeners) {
          listener(code, signal);
        }
      }
    }

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: {
        info: (msg) => infoLogs.push(String(msg)),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/')
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))); },
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => {
        spawnCount += 1;
        activeGeneration = spawnCount;
        const proc = new FakeChildProc(1000 + spawnCount);
        if (spawnCount === 1) {
          setTimeout(() => proc.emitExit(75, null), 15);
        } else if (spawnCount === 2) {
          setTimeout(() => proc.emitExit(1, null), 15);
        }
        return proc as any;
      },
      fetch: (async () => {
        if (activeGeneration >= 3) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ server: 'routecodex', status: 'ok' })
          } as any;
        }
        return { ok: false, status: 503, json: async () => ({}) } as any;
      }) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' })).resolves.toBe(program);
    expect(spawnCount).toBeGreaterThanOrEqual(3);
    expect(infoLogs.some((line) => line.includes('[client-restart] RouteCodex child restarted on port 5520'))).toBe(true);
  });

  it('registers start command', () => {
    const program = new Command();
    registerStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((c) => c.name() === 'start')).toBe(true);
  });

  it('rejects using --codex and --claude together', async () => {
    const program = new Command();
    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'start', '--codex', '--claude'], { from: 'node' })
    ).rejects.toThrow('exit:1');
  });

  it('does not auto-enable --claude based on providers in config', async () => {
    const program = new Command();
    const captured: { env?: Record<string, string> } = {};
    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({
          httpserver: { port: 5520, host: '127.0.0.1' },
          virtualrouter: { providers: { tabglm: { id: 'tabglm', enabled: true } } }
        }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (_cmd, _args, options) => {
        captured.env = options.env as any;
        return ({ pid: 1, on: () => {}, kill: () => true } as any);
      },
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' });
    expect(captured.env?.ROUTECODEX_SYSTEM_PROMPT_ENABLE).toBeUndefined();
    expect(captured.env?.ROUTECODEX_SYSTEM_PROMPT_SOURCE).toBeUndefined();
  });

  it('exits when config is missing', async () => {
    const errors: string[] = [];
    const program = new Command();
    createStartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      env: {},
      fsImpl: {
        existsSync: () => false,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'start'], { from: 'node' })).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('Please create a RouteCodex user config');
  });

  it('release start runs foreground server by default', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createStartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/')
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return ({ pid: 43210, on: () => {}, kill: () => true } as any);
      },
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'rcc', 'start'], { from: 'node' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('node');
    expect(spawnCalls[0].args).toContain('/tmp/index.js');
    expect(spawnCalls[0].options?.detached).toBeUndefined();
    expect(spawnCalls[0].options?.env?.ROUTECODEX_DAEMON_SUPERVISOR).toBeUndefined();
    expect(spawnCalls[0].options?.env?.ROUTECODEX_EXPECT_PARENT_PID).toBeUndefined();
    expect(spawnCalls[0].options?.env?.RCC_EXPECT_PARENT_PID).toBeUndefined();
  });

  it('release start runs daemon supervisor when ROUTECODEX_START_DAEMON=1', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any; unrefCalled?: boolean }> = [];
    const program = new Command();

    createStartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_START_DAEMON: '1' },
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/')
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (command, args, options) => {
        const call = { command, args, options, unrefCalled: false };
        spawnCalls.push(call);
        return {
          pid: 43210,
          on: () => {},
          kill: () => true,
          unref: () => { call.unrefCalled = true; }
        } as any;
      },
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'start'], { from: 'node' })).rejects.toThrow('exit:0');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('node');
    expect(spawnCalls[0].args).toContain('/tmp/cli.js');
    expect(spawnCalls[0].args).toContain('start');
    expect(spawnCalls[0].options?.detached).toBe(true);
    expect(spawnCalls[0].options?.stdio).toBe('ignore');
    expect(spawnCalls[0].options?.env?.ROUTECODEX_DAEMON_SUPERVISOR).toBe('1');
    expect(spawnCalls[0].unrefCalled).toBe(true);
  });

  it('forces restart by default', async () => {
    const program = new Command();
    const portChecks: Array<{ restart?: boolean }> = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' });
    expect(portChecks).toHaveLength(1);
    expect(portChecks[0]?.restart).toBe(true);
  });

  it('uses restart flow when --restart is provided', async () => {
    const program = new Command();
    const portChecks: Array<{ restart?: boolean }> = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--restart'], { from: 'node' });
    expect(portChecks).toHaveLength(1);
    expect(portChecks[0]?.restart).toBe(true);
  });

  it('uses non-restart flow when --no-restart is provided', async () => {
    const program = new Command();
    const portChecks: Array<{ restart?: boolean }> = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => JSON.stringify({ httpserver: { port: 5520, host: '127.0.0.1' } }),
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--no-restart'], { from: 'node' });
    expect(portChecks).toHaveLength(1);
    expect(portChecks[0]?.restart).toBe(false);
  });
});
