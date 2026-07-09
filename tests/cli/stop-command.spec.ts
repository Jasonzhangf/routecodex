import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStopCommand } from '../../src/cli/commands/stop.js';
import { registerStopCommand } from '../../src/cli/register/stop-command.js';

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

describe('cli stop command', () => {
  it('registers stop command', () => {
    const program = new Command();
    registerStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new Error('no server');
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((c) => c.name() === 'stop')).toBe(true);
  });

  it('allows stop when password is not configured', async () => {
    const program = new Command();
    const succeeded: string[] = [];
    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () =>
        ({
          ...createStubSpinner(),
          succeed: (msg?: string) => {
            if (msg) succeeded.push(msg);
          }
        }) as any,
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new Error('no server');
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' });
    expect(succeeded.join('\n')).toContain('No server listening on 5520');
  });

  it('denies stop when password is configured but missing', async () => {
    const program = new Command();
    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      env: { ROUTECODEX_STOP_PASSWORD: 'welcome4zcam#' },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' })).rejects.toThrow('exit:1');
  });

  it('exits with 1 in release mode when config is missing', async () => {
    const errors: string[] = [];
    const info: string[] = [];

    const program = new Command();
    createStopCommand(program, {
      isDevPackage: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: {
        info: (msg) => info.push(msg),
        error: (msg) => errors.push(msg)
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      env: {},
      fsImpl: { existsSync: () => false, readFileSync: () => '' },
      pathImpl: { join: (...parts: string[]) => parts.join('/') },
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'stop'], { from: 'node' })).rejects.toThrow(
      'exit:1'
    );
    expect(errors.join('\n')).toContain('Cannot determine server port');
    expect(info.join('\n')).toContain('rcc config init');
  });

  it('prints no server when nothing listens', async () => {
    const program = new Command();
    const succeeded: string[] = [];
    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () =>
        ({
          ...createStubSpinner(),
          succeed: (msg?: string) => {
            if (msg) succeeded.push(msg);
          }
        }) as any,
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new Error('no server');
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' });
    expect(succeeded.join('\n')).toContain('No server listening on 5520');
  });

  it('does not fail stop when guardian shutdown is unavailable', async () => {
    const program = new Command();
    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      stopGuardianDaemon: async () => {
        throw new Error('guardian unavailable');
      },
      reportGuardianLifecycle: async () => false,
      fetchImpl: (async () => {
        throw new Error('no server');
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' })).resolves.toBe(program);
  });

  it('does not fail pid-based stop when guardian lifecycle reporting is unavailable', async () => {
    const program = new Command();
    let pidChecks = 0;
    const shutdownPorts: number[] = [];
    const shutdownHeaders: Array<Record<string, string>> = [];
    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => {
        pidChecks += 1;
        return pidChecks === 1 ? [12345] : [];
      },
      killPidBestEffort: () => {},
      sleep: async () => {},
      stopGuardianDaemon: async () => {
        throw new Error('guardian unavailable');
      },
      reportGuardianLifecycle: async () => {
        throw new Error('guardian lifecycle unavailable');
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const text = String(url);
        if (text.endsWith('/shutdown')) {
          shutdownPorts.push(Number(new URL(text).port));
          shutdownHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
          return { ok: true, status: 200 };
        }
        throw new Error('server stopped');
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' })).resolves.toBe(program);
    expect(shutdownPorts).toEqual([5520]);
    expect(shutdownHeaders[0]).toEqual(expect.objectContaining({
      'x-routecodex-stop-caller-pid': expect.stringMatching(/^\d+$/),
      'x-routecodex-stop-caller-ts': expect.any(String),
      'x-routecodex-stop-caller-cwd': expect.any(String),
      'x-routecodex-stop-caller-cmd': expect.any(String),
    }));
  });

  it('falls back to explicit managed PID SIGTERM when HTTP shutdown does not release the port', async () => {
    const program = new Command();
    let alive = true;
    const shutdownPorts: number[] = [];
    const shutdownHeaders: Array<Record<string, string>> = [];
    const killCalls: Array<{ pid: number; force: boolean }> = [];

    createStopCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => (alive ? [12345] : []),
      killPidBestEffort: (pid, opts) => {
        killCalls.push({ pid, force: opts.force });
        if (!opts.force) {
          alive = false;
        }
      },
      sleep: async () => {},
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const text = String(url);
        if (text.endsWith('/shutdown')) {
          shutdownPorts.push(Number(new URL(text).port));
          shutdownHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
          return { ok: true, status: 200 };
        }
        return { ok: true, status: 200 };
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' })).resolves.toBe(program);
    expect(shutdownPorts).toContain(5520);
    expect(shutdownHeaders[0]).toEqual(expect.objectContaining({
      'x-routecodex-stop-caller-pid': expect.stringMatching(/^\d+$/),
      'x-routecodex-stop-caller-ts': expect.any(String),
      'x-routecodex-stop-caller-cwd': expect.any(String),
      'x-routecodex-stop-caller-cmd': expect.any(String),
    }));
    expect(killCalls).toEqual([{ pid: 12345, force: false }]);
  });

  it('release stop expands a matched config port to the full port group and shuts down healthy no-pid servers', async () => {
    const previousConfig = process.env.ROUTECODEX_CONFIG_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stop-command-'));
    const configPath = path.join(tempDir, 'config.toml');
    fs.writeFileSync(configPath, `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520

[[httpserver.ports]]
port = 5555

[[httpserver.ports]]
port = 10000
`);
    process.env.ROUTECODEX_CONFIG_PATH = configPath;
    const program = new Command();
    const shutdownPorts: number[] = [];
    const shutdownHeaders: Array<Record<string, string>> = [];

    try {
      createStopCommand(program, {
        isDevPackage: false,
        defaultDevPort: 5520,
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, error: () => {} },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        sleep: async () => {},
        env: {},
        fsImpl: fs,
        pathImpl: { join: (...parts: string[]) => parts.join('/') },
        getHomeDir: () => '/home/test',
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const text = String(url);
          if (text.endsWith('/shutdown')) {
            shutdownPorts.push(Number(new URL(text).port));
            shutdownHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
            return { ok: true, status: 200 };
          }
          throw new Error('server stopped');
        }) as any,
        exit: (code) => {
          throw new Error(`exit:${code}`);
        }
      });

      await program.parseAsync(['node', 'rcc', 'stop'], { from: 'node' });
      expect(shutdownPorts).toEqual([4444, 5520, 5555, 10000]);
      expect(shutdownHeaders).toHaveLength(4);
      expect(shutdownHeaders[0]).toEqual(expect.objectContaining({
        'x-routecodex-stop-caller-pid': expect.stringMatching(/^\d+$/),
        'x-routecodex-stop-caller-ts': expect.any(String),
        'x-routecodex-stop-caller-cwd': expect.any(String),
        'x-routecodex-stop-caller-cmd': expect.any(String),
      }));
    } finally {
      if (previousConfig === undefined) {
        delete process.env.ROUTECODEX_CONFIG_PATH;
      } else {
        process.env.ROUTECODEX_CONFIG_PATH = previousConfig;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('release stop treats later no-pid group ports as stopped after an earlier shutdown closes the process', async () => {
    const previousConfig = process.env.ROUTECODEX_CONFIG_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stop-command-'));
    const configPath = path.join(tempDir, 'config.toml');
    fs.writeFileSync(configPath, `
[httpserver]
port = 5520
host = "127.0.0.1"

[[httpserver.ports]]
port = 4444

[[httpserver.ports]]
port = 5520
`);
    process.env.ROUTECODEX_CONFIG_PATH = configPath;
    const program = new Command();
    const succeeded: string[] = [];
    const shutdownPorts: number[] = [];

    try {
      createStopCommand(program, {
        isDevPackage: false,
        defaultDevPort: 5520,
        createSpinner: async () =>
          ({
            ...createStubSpinner(),
            succeed: (msg?: string) => {
              if (msg) succeeded.push(msg);
            }
          }) as any,
        logger: { info: () => {}, error: () => {} },
        findListeningPids: () => [],
        killPidBestEffort: () => {},
        sleep: async () => {},
        env: {},
        fsImpl: fs,
        pathImpl: { join: (...parts: string[]) => parts.join('/') },
        getHomeDir: () => '/home/test',
        fetchImpl: (async (url: string | URL | Request) => {
          const text = String(url);
          const parsed = new URL(text);
          const port = Number(parsed.port);
          if (text.endsWith('/shutdown') && port === 4444) {
            shutdownPorts.push(port);
            return { ok: true, status: 200 };
          }
          throw new Error('network_error');
        }) as any,
        exit: (code) => {
          throw new Error(`exit:${code}`);
        }
      });

      await program.parseAsync(['node', 'rcc', 'stop'], { from: 'node' });
      expect(shutdownPorts).toEqual([4444]);
      expect(succeeded.join('\n')).toContain('RouteCodex server stopped on 4444');
      expect(succeeded.join('\n')).toContain('No server listening on 5520');
    } finally {
      if (previousConfig === undefined) {
        delete process.env.ROUTECODEX_CONFIG_PATH;
      } else {
        process.env.ROUTECODEX_CONFIG_PATH = previousConfig;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
