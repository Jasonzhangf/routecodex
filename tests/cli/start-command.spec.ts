import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStartCommand } from '../../src/cli/commands/start.js';
import { resolveReleaseDaemonEnabled } from '../../src/cli/commands/start-utils.js';
import { registerStartCommand } from '../../src/cli/register/start-command.js';
import { resolveDaemonStopIntentPath } from '../../src/utils/daemon-stop-intent.js';

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

function createFakeChild(pid = 43210) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: null,
    stderr: null,
    on: () => createFakeChild(pid),
    once: () => createFakeChild(pid),
    kill: () => true,
    unref: () => {}
  } as any;
}

function createExitableFakeChild(pid = 43210, exitDelayMs = 0, code: number | null = 0, signal: NodeJS.Signals | null = null) {
  const handlers = new Map<string, Array<(exitCode: number | null, exitSignal: NodeJS.Signals | null) => void>>();
  const child = {
    pid,
    exitCode: exitDelayMs === 0 ? code : null as number | null,
    signalCode: exitDelayMs === 0 ? signal : null as NodeJS.Signals | null,
    stdout: null,
    stderr: null,
    on: (event: string, handler: (exitCode: number | null, exitSignal: NodeJS.Signals | null) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return child;
    },
    once: (event: string, handler: (exitCode: number | null, exitSignal: NodeJS.Signals | null) => void) => {
      const wrapped = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((item) => item !== wrapped));
        handler(exitCode, exitSignal);
      };
      return child.on(event, wrapped);
    },
    kill: (nextSignal?: NodeJS.Signals) => {
      child.exitCode = null;
      child.signalCode = nextSignal ?? 'SIGTERM';
      const listeners = [...(handlers.get('exit') ?? [])];
      for (const listener of listeners) {
        listener(child.exitCode, child.signalCode);
      }
      return true;
    },
    unref: () => {}
  } as any;
  const emitExit = () => {
    child.exitCode = code;
    child.signalCode = signal;
    const listeners = [...(handlers.get('exit') ?? [])];
    for (const listener of listeners) {
      listener(code, signal);
    }
  };
  if (exitDelayMs === 0) {
    queueMicrotask(emitExit);
  } else {
    setTimeout(emitExit, exitDelayMs);
  }
  return child;
}

describe('cli start command', () => {
  it('keeps release start foreground unless daemon is explicitly enabled', () => {
    expect(resolveReleaseDaemonEnabled({})).toBe(false);
    expect(resolveReleaseDaemonEnabled({ ROUTECODEX_START_DAEMON: '1' })).toBe(true);
    expect(resolveReleaseDaemonEnabled({ RCC_START_DAEMON: '1' })).toBe(true);
    expect(resolveReleaseDaemonEnabled({ ROUTECODEX_START_DAEMON: '0' })).toBe(false);
    expect(resolveReleaseDaemonEnabled({ RCC_START_DAEMON: 'false' })).toBe(false);
  });

  it('starts only the requested port from a multi-port config', async () => {
    const program = new Command();
    const configPath = '/tmp/rcc/config.toml';
    const checkedPorts: number[] = [];
    const spawnCalls: Array<{ options: any }> = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: (target: string) => target === configPath || target === '/tmp/index.js' || target === '/tmp/modules.json',
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 5520
mode = "router"
routingPolicyGroup = "gateway_priority_5520"

[[httpserver.ports]]
port = 10000
mode = "router"
routingPolicyGroup = "gateway_coding_10000"
`,
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (port) => { checkedPorts.push(port); },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (_command, _args, options) => {
        spawnCalls.push({ options });
        return createFakeChild(12345);
      },
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      setupKeypress: () => () => undefined,
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--config', configPath, '--port', '10000'], { from: 'node' });

    expect(checkedPorts).toEqual([10000]);
    expect(spawnCalls[0]?.options.env.ROUTECODEX_PORT).toBe('10000');
    expect(spawnCalls[0]?.options.env.RCC_PORT).toBe('10000');
  });

  it('managed restart succeeds when the restarted child becomes healthy', async () => {
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
        }
        return proc as any;
      },
      fetch: (async () => {
        if (activeGeneration >= 2) {
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
    expect(spawnCount).toBe(2);
    expect(infoLogs.some((line) => line.includes('[client-restart] RouteCodex child restarted on port 5520'))).toBe(true);
  });

  it('managed restart stops after first failed restarted child bootstrap', async () => {
    const program = new Command();
    const infoLogs: string[] = [];
    const errorLogs: string[] = [];
    let spawnCount = 0;
    let exitCode: number | null = null;

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
        error: (msg) => errorLogs.push(String(msg))
      },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => {
        spawnCount += 1;
        const proc = new FakeChildProc(3000 + spawnCount);
        setTimeout(() => {
          proc.emitExit(spawnCount === 1 ? 75 : 1, null);
        }, 15);
        return proc as any;
      },
      fetch: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      exit: (code) => {
        exitCode = code;
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' })).resolves.toBe(program);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spawnCount).toBe(2);
    expect(exitCode).toBe(1);
    expect(infoLogs.some((line) => line.includes('[client-restart] RouteCodex requested managed restart on port 5520'))).toBe(true);
    expect(errorLogs.some((line) => line.includes('attempt=1 child exited early'))).toBe(true);
  });

  it('managed restart re-resolves current install entry instead of reusing stale absolute release path', async () => {
    const program = new Command();
    const spawnedArgs: string[][] = [];
    let spawnCount = 0;
    let activeGeneration = 0;
    let currentCliEntry = '/home/test/.rcc/install/current/dist/cli.js';

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
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: (target: string) => {
          if (target === '/tmp/modules.json') {
            return true;
          }
          if (target === '/tmp/index.js') {
            return true;
          }
          if (target === '/home/test/.rcc/install/current/dist/index.js') {
            return true;
          }
          if (target === '/home/test/.rcc/install/current/config/modules.json') {
            return true;
          }
          return true;
        },
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: path as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))); },
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (_bin, childArgs) => {
        spawnedArgs.push([...childArgs]);
        spawnCount += 1;
        activeGeneration = spawnCount;
        const proc = new FakeChildProc(2000 + spawnCount);
        if (spawnCount === 1) {
          setTimeout(() => {
            currentCliEntry = '/home/test/.rcc/install/current/dist/cli.js';
            process.argv[1] = currentCliEntry;
            proc.emitExit(75, null);
          }, 15);
        }
        return proc as any;
      },
      fetch: (async () => {
        if (activeGeneration >= 2) {
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
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    const originalArgv1 = process.argv[1];
    process.argv[1] = currentCliEntry;
    try {
      await expect(program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' })).resolves.toBe(program);
    } finally {
      process.argv[1] = originalArgv1;
    }

    expect(spawnedArgs.length).toBeGreaterThanOrEqual(2);
    expect(spawnedArgs[0][0]).toBe('/home/test/.rcc/install/current/dist/index.js');
    expect(spawnedArgs[0][1]).toBe('/home/test/.rcc/install/current/config/modules.json');
    expect(spawnedArgs[1][0]).toBe('/home/test/.rcc/install/current/dist/index.js');
    expect(spawnedArgs[1][1]).toBe('/home/test/.rcc/install/current/config/modules.json');
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
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
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
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (_cmd, _args, options) => {
        captured.env = options.env as any;
        return createFakeChild(1);
      },
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--config', '/tmp/config.toml'], { from: 'node' });
    expect(captured.env?.ROUTECODEX_SYSTEM_PROMPT_ENABLE).toBeUndefined();
    expect(captured.env?.ROUTECODEX_SYSTEM_PROMPT_SOURCE).toBeUndefined();
  });

  it('spawns server child from package root and injects base dir env', async () => {
    const program = new Command();
    const spawns: Array<{ cwd?: string; env?: Record<string, string> }> = [];
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (value: string) => value.split('/').slice(0, -1).join('/') || '/',
        basename: (value: string) => value.split('/').filter(Boolean).pop() || ''
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/repo/dist/index.js',
      spawn: (_bin, _args, options) => {
        spawns.push(options as { cwd?: string; env?: Record<string, string> });
        return {
          pid: 2001,
          stdout: null,
          stderr: null,
          on: () => {},
          kill: () => true
        } as any;
      },
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'start'], { from: 'node' })).resolves.toBe(program);
    expect(spawns[0]?.cwd).toBe('/repo');
    expect(spawns[0]?.env?.ROUTECODEX_BASEDIR).toBe('/repo');
    expect(spawns[0]?.env?.RCC_BASEDIR).toBe('/repo');
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
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return createFakeChild(43210);
      },
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
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

  it('release foreground start is launch-only by default and preserves explicit --exclusive', async () => {
    const restartFlags: Array<boolean | undefined> = [];
    const createContext = () => ({
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_START_DAEMON: '0' },
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {},
        createWriteStream: () => ({ write: () => true, end: () => {} } as any)
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (_port: number, _spinner: any, opts?: { restart?: boolean }) => {
        restartFlags.push(opts?.restart);
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(43210),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      }
    });

    const defaultProgram = new Command();
    createStartCommand(defaultProgram, createContext());
    await defaultProgram.parseAsync(['node', 'rcc', 'start'], { from: 'node' });

    const noRestartProgram = new Command();
    createStartCommand(noRestartProgram, createContext());
    await noRestartProgram.parseAsync(['node', 'rcc', 'start', '--no-restart'], { from: 'node' });

    const exclusiveProgram = new Command();
    createStartCommand(exclusiveProgram, createContext());
    await exclusiveProgram.parseAsync(['node', 'rcc', 'start', '--exclusive'], { from: 'node' });

    expect(restartFlags).toEqual([false, false, true]);
  });

  it('writes daemon stop intent before explicit foreground exclusive takeover', async () => {
    const previousRccHome = process.env.RCC_HOME;
    const previousRouteCodexUserDir = process.env.ROUTECODEX_USER_DIR;
    const previousRouteCodexHome = process.env.ROUTECODEX_HOME;
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-start-stop-intent-'));
    const configPath = path.join(tempHome, 'config.toml');
    const checkedPorts: number[] = [];
    const program = new Command();

    try {
      createStartCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5520,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
        env: { ROUTECODEX_START_DAEMON: '0' },
        fsImpl: {
          existsSync: (target: string) => target === configPath || target === '/tmp/index.js' || target === '/tmp/modules.json',
          statSync: () => ({ isDirectory: () => false } as any),
          readFileSync: () => `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520
`,
          writeFileSync: () => {},
          mkdtempSync: () => '/tmp/rc',
          mkdirSync: () => {},
          createWriteStream: () => ({ write: () => true, end: () => {} } as any)
        } as any,
        pathImpl: {
          join: (...parts: string[]) => parts.join('/'),
          resolve: (...parts: string[]) => parts.join('/'),
          dirname: (target: string) => path.posix.dirname(target),
          basename: (target: string) => path.posix.basename(target)
        } as any,
        homedir: () => tempHome,
        tmpdir: () => '/tmp',
        sleep: async () => {},
        ensureLocalTokenPortalEnv: async () => {},
        ensurePortAvailable: async (port) => {
          checkedPorts.push(port);
          const intentPath = resolveDaemonStopIntentPath(port, path.join(tempHome, '.rcc'));
          expect(fs.existsSync(intentPath)).toBe(true);
        },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveCliEntryPath: () => '/tmp/cli.js',
        resolveServerEntryPath: () => '/tmp/index.js',
        spawn: () => createFakeChild(43210),
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ server: 'routecodex', status: 'ok' })
        })) as any,
        setupKeypress: () => () => {},
        waitForever: async () => {},
        exit: (code: number) => {
          throw new Error(`exit:${code}`);
        }
      });

      await program.parseAsync(['node', 'rcc', 'start', '--config', configPath, '--exclusive'], { from: 'node' });
      expect(checkedPorts).toEqual([4444, 5520]);
    } finally {
      if (previousRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = previousRccHome;
      }
      if (previousRouteCodexUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = previousRouteCodexUserDir;
      }
      if (previousRouteCodexHome === undefined) {
        delete process.env.ROUTECODEX_HOME;
      } else {
        process.env.ROUTECODEX_HOME = previousRouteCodexHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('release daemon exclusive takeover preserves stop intent for old supervisors and marks the new supervisor to ignore it', async () => {
    const previousRccHome = process.env.RCC_HOME;
    const previousRouteCodexUserDir = process.env.ROUTECODEX_USER_DIR;
    const previousRouteCodexHome = process.env.ROUTECODEX_HOME;
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-daemon-takeover-intent-'));
    const configPath = path.join(tempHome, 'config.toml');
    const cliPath = path.join(tempHome, 'dist', 'cli.js');
    const indexPath = path.join(tempHome, 'dist', 'index.js');
    const modulesPath = path.join(tempHome, 'config', 'modules.json');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.mkdirSync(path.dirname(modulesPath), { recursive: true });
    fs.writeFileSync(cliPath, '', 'utf8');
    fs.writeFileSync(indexPath, '', 'utf8');
    fs.writeFileSync(modulesPath, '{}', 'utf8');
    fs.writeFileSync(configPath, `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520
`, 'utf8');

    const checkedPorts: number[] = [];
    let spawnedEnv: NodeJS.ProcessEnv | null = null;
    const program = new Command();

    try {
      createStartCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5520,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
        env: { ROUTECODEX_START_DAEMON: '1' },
        fsImpl: fs as any,
        pathImpl: path as any,
        homedir: () => tempHome,
        tmpdir: () => os.tmpdir(),
        sleep: async () => {},
        ensureLocalTokenPortalEnv: async () => {},
        ensurePortAvailable: async (port) => {
          checkedPorts.push(port);
          const intentPath = resolveDaemonStopIntentPath(port, path.join(tempHome, '.rcc'));
          expect(fs.existsSync(intentPath)).toBe(true);
        },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        getModulesConfigPath: () => modulesPath,
        resolveCliEntryPath: () => cliPath,
        resolveServerEntryPath: () => indexPath,
        spawn: (_command, _args, options) => {
          spawnedEnv = options.env as NodeJS.ProcessEnv;
          return createFakeChild(43210);
        },
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true })
        })) as any,
        setupKeypress: () => () => {},
        waitForever: async () => {},
        exit: (code: number) => {
          throw new Error(`exit:${code}`);
        }
      });

      await expect(program.parseAsync(['node', 'rcc', 'start', '--config', configPath, '--snap', '--exclusive'], { from: 'node' })).rejects.toThrow('exit:0');
      expect(checkedPorts).toEqual([4444, 5520]);
      expect(spawnedEnv?.ROUTECODEX_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID).toBe(String(process.pid));
      expect(spawnedEnv?.RCC_DAEMON_SUPERVISOR_IGNORE_STOP_INTENT_PID).toBe(String(process.pid));
      for (const port of checkedPorts) {
        const intentPath = resolveDaemonStopIntentPath(port, path.join(tempHome, '.rcc'));
        expect(fs.existsSync(intentPath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(intentPath, 'utf8')) as { pid?: number; source?: string };
        expect(parsed.pid).toBe(process.pid);
        expect(parsed.source).toBe('cli.start.exclusive_takeover');
      }
    } finally {
      if (previousRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = previousRccHome;
      }
      if (previousRouteCodexUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = previousRouteCodexUserDir;
      }
      if (previousRouteCodexHome === undefined) {
        delete process.env.ROUTECODEX_HOME;
      } else {
        process.env.ROUTECODEX_HOME = previousRouteCodexHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('does not interrupt another start while the same port group is taking over', async () => {
    const previousRccHome = process.env.RCC_HOME;
    const previousRouteCodexUserDir = process.env.ROUTECODEX_USER_DIR;
    const previousRouteCodexHome = process.env.ROUTECODEX_HOME;
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-start-lock-'));
    const configPath = path.join(tempHome, 'config.toml');
    fs.writeFileSync(configPath, `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520
`, 'utf8');
    const lockDir = path.join(tempHome, '.rcc', 'state', 'runtime-lifecycle', 'start-locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, '4444-5520.lock'),
      JSON.stringify({ pid: 999999, ports: [4444, 5520], startedAtMs: Date.now() }),
      'utf8'
    );
    const checkedPorts: number[] = [];
    const program = new Command();

    try {
      createStartCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5520,
        nodeBin: 'node',
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
        env: { ROUTECODEX_START_LOCK_WAIT_MS: '1000' },
        homedir: () => tempHome,
        tmpdir: () => '/tmp',
        sleep: async () => {},
        ensureLocalTokenPortalEnv: async () => {},
        ensurePortAvailable: async (port) => {
          checkedPorts.push(port);
        },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveCliEntryPath: () => '/tmp/cli.js',
        resolveServerEntryPath: () => '/tmp/index.js',
        spawn: () => {
          throw new Error('spawn should not be called');
        },
        fetch: (async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true })
        })) as any,
        setupKeypress: () => () => {},
        waitForever: async () => {},
        exit: (code: number) => {
          throw new Error(`exit:${code}`);
        }
      });

      await expect(program.parseAsync(['node', 'rcc', 'start', '--config', configPath, '--exclusive'], { from: 'node' })).rejects.toThrow('exit:0');
      expect(checkedPorts).toEqual([]);
    } finally {
      if (previousRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = previousRccHome;
      }
      if (previousRouteCodexUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = previousRouteCodexUserDir;
      }
      if (previousRouteCodexHome === undefined) {
        delete process.env.ROUTECODEX_HOME;
      } else {
        process.env.ROUTECODEX_HOME = previousRouteCodexHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('reports progress while waiting for another start takeover lock', async () => {
    const previousRccHome = process.env.RCC_HOME;
    const previousRouteCodexUserDir = process.env.ROUTECODEX_USER_DIR;
    const previousRouteCodexHome = process.env.ROUTECODEX_HOME;
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-start-lock-progress-'));
    const configPath = path.join(tempHome, 'config.toml');
    fs.writeFileSync(configPath, `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520
`, 'utf8');
    const lockDir = path.join(tempHome, '.rcc', 'state', 'runtime-lifecycle', 'start-locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, '4444-5520.lock'),
      JSON.stringify({ pid: process.pid, ports: [4444, 5520], startedAtMs: Date.now() }),
      'utf8'
    );
    const spinnerInfo: string[] = [];
    const program = new Command();

    try {
      createStartCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5520,
        nodeBin: 'node',
        createSpinner: async () =>
          ({
            ...createStubSpinner(),
            info: (message?: string) => {
              if (message) {
                spinnerInfo.push(message);
              }
            }
          }) as any,
        logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
        env: { ROUTECODEX_START_LOCK_WAIT_MS: '1000' },
        homedir: () => tempHome,
        tmpdir: () => '/tmp',
        sleep: async () => {},
        ensureLocalTokenPortalEnv: async () => {},
        ensurePortAvailable: async () => {
          throw new Error('ensurePortAvailable should not run while takeover lock is held');
        },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        getModulesConfigPath: () => '/tmp/modules.json',
        resolveCliEntryPath: () => '/tmp/cli.js',
        resolveServerEntryPath: () => '/tmp/index.js',
        spawn: () => {
          throw new Error('spawn should not be called');
        },
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ server: 'routecodex', status: 'starting', ready: false, pipelineReady: false })
        })) as any,
        setupKeypress: () => () => {},
        waitForever: async () => {},
        exit: (code: number) => {
          throw new Error(`exit:${code}`);
        }
      });

      await expect(program.parseAsync(['node', 'rcc', 'start', '--config', configPath, '--exclusive'], { from: 'node' })).rejects.toThrow('exit:1');
      expect(spinnerInfo.some((line) => line.includes('another start is already taking over'))).toBe(true);
      expect(spinnerInfo.some((line) => line.includes('waiting for existing start takeover to finish'))).toBe(true);
    } finally {
      if (previousRccHome === undefined) {
        delete process.env.RCC_HOME;
      } else {
        process.env.RCC_HOME = previousRccHome;
      }
      if (previousRouteCodexUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = previousRouteCodexUserDir;
      }
      if (previousRouteCodexHome === undefined) {
        delete process.env.ROUTECODEX_HOME;
      } else {
        process.env.ROUTECODEX_HOME = previousRouteCodexHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
          ...createFakeChild(43210),
          unref: () => { call.unrefCalled = true; }
        } as any;
      },
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
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

  it('release foreground start enables --snap by default', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any; unrefCalled?: boolean }> = [];
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (command, args, options) => {
        const call = { command, args, options, unrefCalled: false };
        spawnCalls.push(call);
        return createFakeChild(43210);
      },
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'rcc', 'start', '--snap'], { from: 'node' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('/tmp/index.js');
    expect(spawnCalls[0].options?.env?.ROUTECODEX_SNAPSHOT).toBe('1');
    expect(spawnCalls[0].options?.detached).toBeUndefined();
    expect(spawnCalls[0].options?.env?.ROUTECODEX_DAEMON_SUPERVISOR).toBeUndefined();
  });

  it('release daemon start waits for child health before reporting success', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any; unrefAtFetchCall?: number }> = [];
    const program = new Command();
    let fetchCalls = 0;

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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: (command, args, options) => {
        const call = { command, args, options, unrefAtFetchCall: undefined as number | undefined };
        spawnCalls.push(call);
        return {
          ...createFakeChild(43210),
          unref: () => { call.unrefAtFetchCall = fetchCalls; }
        } as any;
      },
      fetch: (async () => {
        fetchCalls += 1;
        const ready = fetchCalls >= 3;
        return {
          ok: true,
          status: 200,
          json: async () => ready
            ? ({ server: 'routecodex', status: 'ok' })
            : ({ server: 'routecodex', status: 'starting', ready: false, pipelineReady: false })
        };
      }) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'start', '--snap'], { from: 'node' })).rejects.toThrow('exit:0');
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].unrefAtFetchCall).toBeGreaterThanOrEqual(3);
  });

  it('release daemon start exits nonzero and stops supervisor when health never becomes ready', async () => {
    const program = new Command();
    const killCalls: Array<{ pid: number; force: boolean }> = [];
    const failMessages: string[] = [];

    createStartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () =>
        ({
          ...createStubSpinner(),
          fail: (msg?: string) => {
            if (msg) {
              failMessages.push(msg);
            }
          }
        }) as any,
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_START_DAEMON: '1' },
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
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
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: (pid, opts) => {
        killCalls.push({ pid, force: opts.force });
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveCliEntryPath: () => '/tmp/cli.js',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createExitableFakeChild(43210, 0, 1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'starting', ready: false, pipelineReady: false })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'start', '--snap'], { from: 'node' })).rejects.toThrow('exit:1');
    expect(failMessages.join('\n')).toContain('daemon supervisor exited before server became ready');
    expect(killCalls).toEqual([
      { pid: 43210, force: false },
      { pid: 43210, force: true }
    ]);
  });

  it('uses launch-only flow by default', async () => {
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--config', '/tmp/config.toml'], { from: 'node' });
    expect(portChecks).toHaveLength(1);
    expect(portChecks[0]?.restart).toBe(false);
  });

  it('refuses explicit --restart takeover when a runtime already listens', async () => {
    // runtime.lifecycle.start_command: refuseExplicitRestartTakeoverIfOccupied
    const program = new Command();
    const portChecks: Array<{ restart?: boolean }> = [];
    const errors: string[] = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (message: string) => errors.push(message) },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
        throw new Error('ensurePortAvailable should not run for explicit --restart takeover');
      },
      findListeningPids: () => [1234],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'start', '--config', '/tmp/config.toml', '--restart'], { from: 'node' })
    ).rejects.toThrow('exit:1');
    expect(portChecks).toHaveLength(0);
    expect(errors.join('\n')).toContain('rcc restart --port 5520');
  });

  it('refuses default start takeover when a runtime already listens', async () => {
    const program = new Command();
    const portChecks: Array<{ restart?: boolean }> = [];
    const errors: string[] = [];

    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (message: string) => errors.push(message) },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
        throw new Error('ensurePortAvailable should not run for default start takeover');
      },
      findListeningPids: () => [1234],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'start', '--config', '/tmp/config.toml'], { from: 'node' })
    ).rejects.toThrow('exit:1');
    expect(portChecks).toHaveLength(0);
    expect(errors.join('\n')).toContain('rcc restart --port 5520');
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
        readFileSync: () => '[httpserver]\nport = 5520\nhost = "127.0.0.1"\n',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: {
        join: (...parts: string[]) => parts.join('/'),
        resolve: (...parts: string[]) => parts.join('/'),
        dirname: (target: string) => path.posix.dirname(target),
        basename: (target: string) => path.posix.basename(target)
      } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensurePortAvailable: async (_port, _spinner, opts) => {
        portChecks.push(opts ?? {});
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => createFakeChild(1),
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ server: 'routecodex', status: 'ok' })
      })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'start', '--config', '/tmp/config.toml', '--no-restart'], { from: 'node' });
    expect(portChecks).toHaveLength(1);
    expect(portChecks[0]?.restart).toBe(false);
  });
});
