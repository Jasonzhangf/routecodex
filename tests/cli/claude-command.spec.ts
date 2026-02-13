import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createClaudeCommand } from '../../src/cli/commands/claude.js';

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

function findTmuxLaunchCall(
  tmuxCalls: Array<{ command: string; args: string[] }>
): { command: string; args: string[] } | undefined {
  return tmuxCalls.find((call) => {
    if (call.command !== 'tmux') {
      return false;
    }
    return call.args[0] === 'respawn-pane' || (call.args[0] === 'send-keys' && call.args.includes('-l'));
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

describe('cli claude command', () => {
  it('registers and launches claude with passthrough args', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createClaudeCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['claude', '--url', 'http://localhost:1234/proxy', '--model', 'sonnet', '--', '--foo', 'bar'],
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
      ['node', 'routecodex', 'claude', '--url', 'http://localhost:1234/proxy', '--model', 'sonnet', '--', '--foo', 'bar'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('claude');
    expect(spawnCalls[0].args).toEqual(['--model', 'sonnet', '--foo', 'bar']);
    expect(spawnCalls[0].options?.env?.ANTHROPIC_BASE_URL).toBe('http://0.0.0.0:1234/proxy');
  });

  it('passes downstream -p args while still honoring launcher --port', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const program = new Command();

    createClaudeCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['claude', '--dangerously-skip-permissions', '-p', 'rcm', '--port', '5520'],
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
      ['node', 'routecodex', 'claude', '--dangerously-skip-permissions', '-p', 'rcm', '--port', '5520'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('claude');
    expect(spawnCalls[0].args).toEqual(['--dangerously-skip-permissions', '-p', 'rcm']);
    expect(spawnCalls[0].options?.env?.ANTHROPIC_BASE_URL).toBe('http://0.0.0.0:5520');
  });

  it('auto-starts server in background when routecodex is unavailable', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    let readyChecks = 0;

    const program = new Command();
    createClaudeCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: { ROUTECODEX_CLOCK_RECLAIM_REQUIRED: '0' },
      rawArgv: ['claude', '--', '--help'],
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

    await program.parseAsync(['node', 'routecodex', 'claude', '--', '--help'], { from: 'node' });

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].command).toBe('node');
    expect(Array.isArray(spawnCalls[0].options?.stdio)).toBe(true);
    expect(spawnCalls[1].command).toBe('claude');
  });

  it('unsets anthropic auth tokens when launching claude in managed tmux session', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
    const tmuxCalls: Array<{ command: string; args: string[] }> = [];
    const program = new Command();

    createClaudeCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {
        ANTHROPIC_API_KEY: 'ak-test',
        ANTHROPIC_AUTH_TOKEN: 'auth-token-should-be-unset',
        ANTHROPIC_TOKEN: 'legacy-token-should-be-unset'
      },
      rawArgv: ['claude', '--url', 'http://localhost:5520/proxy'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any;
        }
        if (url.includes('/daemon/clock-client/register')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
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
        if (args[0] === 'list-sessions') {
          return { status: 0, stdout: '', stderr: '' } as any;
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

    await program.parseAsync(['node', 'routecodex', 'claude', '--url', 'http://localhost:5520/proxy'], { from: 'node' });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('tmux');
    const launchCall = findTmuxLaunchCall(tmuxCalls);
    expect(launchCall).toBeDefined();
    const shellCommand = extractTmuxLaunchShellCommand(launchCall);
    expect(shellCommand).toContain("'-u' 'ANTHROPIC_AUTH_TOKEN'");
    expect(shellCommand).toContain("'-u' 'ANTHROPIC_TOKEN'");
    expect(shellCommand).toContain('while true; do');
    expect(shellCommand).not.toContain('while true; do;');
  });
});
