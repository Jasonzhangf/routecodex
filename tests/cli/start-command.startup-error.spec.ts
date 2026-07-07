import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

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

describe('cli start command startup error fail-fast', () => {
  it('managed restart stops immediately when restarted child leaves startupError lifecycle evidence', async () => {
    const safeReadRuntimeLifecycle = jest.fn(() => ({
      exit: {
        kind: 'startupError',
        message: 'native bootstrapVirtualRouterProvidersJson is required but unavailable'
      }
    }));

    jest.unstable_mockModule('../../src/utils/runtime-exit-forensics.js', () => ({
      resolveRuntimeLifecyclePath: () => '/tmp/runtime-lifecycle.json',
      safeReadRuntimeLifecycle
    }));

    const { createStartCommand } = await import('../../src/cli/commands/start.js');

    const program = new Command();
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
        info: () => {},
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
        const proc = new FakeChildProc(4000 + spawnCount);
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
    expect(errorLogs.some((line) => line.includes('startupError=native bootstrapVirtualRouterProvidersJson is required but unavailable'))).toBe(true);
    expect(errorLogs.some((line) => line.includes('did not become healthy before timeout'))).toBe(false);
  });
});
