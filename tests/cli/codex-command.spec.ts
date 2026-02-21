import { describe, expect, it } from '@jest/globals';
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


function createConfigFs(port: number, apiKey = 'sk-config-key') {
  const configPath = '/home/test/.routecodex/config.json';
  const config = JSON.stringify({ httpserver: { port, apikey: apiKey } });
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
  it('reaps codex child on SIGTERM by default to avoid orphan process', async () => {
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
      env: {},
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

    expect(killSignals).toContain('SIGTERM');
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

  it('forwards SIGTERM to codex child when explicit env switch is enabled', async () => {
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

    expect(killSignals).toContain('SIGTERM');
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
    expect(spawnCalls[0].options?.cwd).toBe(explicitCwd);
    expect(spawnCalls[0].options?.env?.RCC_WORKDIR).toBe(explicitCwd);
    expect(spawnCalls[0].options?.env?.ROUTECODEX_WORKDIR).toBe(explicitCwd);
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

  it('launches codex and exports OpenAI proxy env vars', async () => {
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
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBe('http://0.0.0.0:5520/proxy/v1');
    expect(spawnCalls[0].options?.env?.OPENAI_API_KEY).toBe('rcc-proxy-key');
  });


  it('uses ~/.routecodex/config.json port by default when --url is omitted', async () => {
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
      rawArgv: ['codex'],
      fsImpl: createConfigFs(7788),
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

    await program.parseAsync(['node', 'routecodex', 'codex'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBe('http://0.0.0.0:7788/v1');
  });

  it('lets --port override ~/.routecodex/config.json port when --url is omitted', async () => {
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
      rawArgv: ['codex', '--port', '8899'],
      fsImpl: createConfigFs(7788),
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

    await program.parseAsync(['node', 'routecodex', 'codex', '--port', '8899'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBe('http://0.0.0.0:8899/v1');
  });

  it('passes downstream -p profile args while still honoring launcher --port', async () => {
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
    expect(spawnCalls[0].options?.env?.OPENAI_BASE_URL).toBe('http://0.0.0.0:5520/v1');
  });


  it('accepts explicit --url when /health is ready but /ready is missing', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_CLOCK_RECLAIM_REQUIRED: '0' },
      rawArgv: ['codex', '--url', 'http://localhost:5520'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready')) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        if (url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        return { ok: false, status: 404, json: async () => ({}) } as any;
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

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('codex');
  });

  it('disables advanced clock service when tmux is missing', async () => {
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
    expect(spawnCalls[0].options?.env?.RCC_CLOCK_ADVANCED_ENABLED).toBe('0');
    expect(warnings.some((line) => line.includes('tmux not found'))).toBe(true);
  });

  it('continues launch when clock registration is unavailable without strict tmux-managed child context', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const errors: string[] = [];
    const program = new Command();

    createCodexCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      env: {
        ROUTECODEX_CLOCK_RECLAIM_REQUIRED: '1',
        TMUX: '/tmp/tmux,123,0'
      },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
    expect(errors.some((line) => line.includes('clock client registration failed'))).toBe(false);
  });

  it('re-registers clock client daemon after heartbeat reports missing daemon', async () => {
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
      env: { TMUX: '/tmp/tmux,123,0' },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
          registerCalls += 1;
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/heartbeat')) {
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
    expect(registerCalls).toBe(2);
    expect(heartbeatCalls).toBeGreaterThanOrEqual(1);
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
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'respawn-pane' || call.args[0] === 'send-keys')).toBe(true);
    expect(warnings.some((line) => line.includes('not running inside tmux'))).toBe(false);
  });

  it('reuses orphan managed tmux session before creating a new one', async () => {
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
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-a',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: 'rcc_codex_orphan\t0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes') {
          return { status: 0, stdout: 'rcc_codex_orphan:0.0\tzsh\t/home/test/workspace-a\n', stderr: '' } as any;
        }
        if (args[0] === 'new-session') {
          return { status: 1, stdout: '', stderr: 'should not create new session' } as any;
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
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['attach-session', '-t', 'rcc_codex_orphan']));
    expect(tmuxCalls.some((call) => call.args[0] === 'list-sessions')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(false);
    const launchCall = findTmuxLaunchCall(tmuxCalls, 'rcc_codex_orphan:0.0');
    expect(launchCall).toBeDefined();
    const shellCommand = extractTmuxLaunchShellCommand(launchCall);
    expect(shellCommand).toContain("cd -- '/home/test/workspace-a'");
    expect(shellCommand).not.toContain("tmux kill-session -t 'rcc_codex_orphan'");
    expect(infos.some((line) => line.includes('reused existing managed tmux session'))).toBe(true);
  });

  it('does not reuse orphan managed tmux session when pane cwd differs from current cwd', async () => {
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
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-b',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: 'rcc_codex_orphan\t0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes') {
          return { status: 0, stdout: 'rcc_codex_orphan:0.0\tzsh\t/home/test/other-project\n', stderr: '' } as any;
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
    expect(findTmuxLaunchCall(tmuxCalls, 'rcc_codex_orphan:0.0')).toBeUndefined();
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
      env: {},
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-codex',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: 'rcc_claude_orphan\t0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes') {
          return { status: 0, stdout: 'rcc_claude_orphan:0.0\tzsh\t/home/test/workspace-codex\n', stderr: '' } as any;
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
    expect(findTmuxLaunchCall(tmuxCalls, 'rcc_claude_orphan:0.0')).toBeUndefined();
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
      env: {},
      rawArgv: ["codex", "--url", "http://localhost:5520/proxy"],
      fsImpl: createStubFs(),
      homedir: () => "/home/test",
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith("/ready") || url.endsWith("/health")) {
          return { ok: true, status: 200, json: async () => ({ status: "ok", ready: true }) } as any;
        }
        if (url.includes("/daemon/clock-client/register")) {
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
        if (args[0] === "list-sessions") {
          return { status: 0, stdout: "rcc_codex_busy	0\n", stderr: "" } as any;
        }
        if (args[0] === "list-panes") {
          return { status: 0, stdout: "rcc_codex_busy:0.0	node\n", stderr: "" } as any;
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

  it('when already in tmux, only sticks to current pane if it is idle and cwd-matched; otherwise starts managed session', async () => {
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
      env: { TMUX: '/tmp/tmux,123,0' },
      rawArgv: ['codex', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      cwd: () => '/home/test/workspace-inside',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
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
          return { status: 0, stdout: 's-main:0.0\n', stderr: '' } as any;
        }
        if (args[0] === 'list-panes' && args[2] === 's-main:0.0') {
          return { status: 0, stdout: 'node\t/home/test/workspace-inside\n', stderr: '' } as any;
        }
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: '', stderr: '' } as any;
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
    expect(tmuxCalls.some((call) => call.args[0] === 'display-message')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'list-panes' && call.args[2] === 's-main:0.0')).toBe(true);
    expect(tmuxCalls.some((call) => call.args[0] === 'new-session')).toBe(true);
  });

  it("uses daemon-suffixed proxy api key when advanced clock daemon is active", async () => {
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
      env: {},
      rawArgv: ["codex", "--url", "http://localhost:5520/proxy"],
      fsImpl: createStubFs(),
      homedir: () => "/home/test",
      cwd: () => "/home/test/workspace-clock",
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith("/ready") || url.endsWith("/health")) {
          return { ok: true, status: 200, json: async () => ({ status: "ok", ready: true }) } as any;
        }
        if (url.includes("/daemon/clock-client/register")) {
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
    expect(shellCommand).toContain("OPENAI_API_KEY=rcc-proxy-key::rcc-clockd:");
    expect(shellCommand).toContain("RCC_CLOCK_CLIENT_DAEMON_ID=clockd_");
    expect(shellCommand).toContain("[routecodex][self-heal]");
    expect(shellCommand).toContain("__rcc_max=");
    expect(shellCommand).toContain("while true; do");
    expect(shellCommand).not.toContain("while true; do;");
    expect(shellCommand).not.toContain("tmux kill-session -t 'rcc_codex_");
  });

});
