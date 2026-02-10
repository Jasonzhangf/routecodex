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
      env: {},
      rawArgv: ['claude', '--', '--help'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => {
        readyChecks += 1;
        if (readyChecks <= 1) {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ status: 'ready' }) };
      }) as any,
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
});
