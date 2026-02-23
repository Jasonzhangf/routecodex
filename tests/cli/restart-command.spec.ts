import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createRestartCommand } from '../../src/cli/commands/restart.js';
import { registerRestartCommand } from '../../src/cli/register/restart-command.js';

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

describe('cli restart command', () => {
  it('registers restart command', () => {
    const program = new Command();
    registerRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      sleep: async () => {},
      sendSignal: () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((c) => c.name() === 'restart')).toBe(true);
  });

  it('rejects using --codex and --claude together', async () => {
    const program = new Command();
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      sleep: async () => {},
      sendSignal: () => {},
      fetch: (async () => ({ ok: true, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'restart', '--codex', '--claude'], { from: 'node' })
    ).rejects.toThrow('exit:1');
  });

  it('requests daemon-managed restart for the running server', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => {
        call += 1;
        // first read => existing server pid; subsequent => restarted pid
        return call <= 1 ? [111] : [222];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async () => ({ ok: true, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
          httpserver: { port: 5520, host: '127.0.0.1' },
          virtualrouter: { providers: { tabglm: { id: 'tabglm', enabled: true } } }
        }),
        writeFileSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/') } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart'], { from: 'node' });
    expect(signals).toEqual([]);
  });

  it('supports --port to target a specific server via daemon endpoint', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5520) {
          return [];
        }
        return call <= 1 ? [333] : [444];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async () => ({ ok: true, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    expect(signals).toEqual([]);
  });

  it('accepts same-pid healthy restart without timing out via daemon endpoint', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [777],
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async () => ({ ok: true, json: async () => ({ server: 'routecodex', status: 'ok' }) })) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () =>
          JSON.stringify({
            httpserver: { port: 5520, host: '127.0.0.1' },
            virtualrouter: { providers: { tabglm: { id: 'tabglm', enabled: true } } }
          }),
        writeFileSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/') } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart'], { from: 'node' });
    expect(signals).toEqual([]);
  });
});
