import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createCodeCommand } from '../../src/cli/commands/code.js';

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
    }
  } as any;
}

describe('cli code command', () => {
  it('spawns Claude with passthrough args and sets ANTHROPIC_BASE_URL from --url', async () => {
    const program = new Command();
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];

    createCodeCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: [
        'code',
        '--url',
        'http://localhost:1234/proxy',
        '--model',
        'sonnet',
        '--',
        '--foo',
        'bar'
      ],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true })) as any,
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
      ['node', 'routecodex', 'code', '--url', 'http://localhost:1234/proxy', '--model', 'sonnet', '--', '--foo', 'bar'],
      { from: 'node' }
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.command).toBe('claude');
    expect(spawnCalls[0]!.args).toEqual(['--model', 'sonnet', '--foo', 'bar']);
    expect(spawnCalls[0]!.options?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234/proxy');
  });

  it('errors when port cannot be resolved (release mode, no --url)', async () => {
    const program = new Command();
    createCodeCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['code'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true })) as any,
      spawn: () => ({ on: () => {}, kill: () => true } as any),
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'code'], { from: 'node' })).rejects.toThrow('exit:1');
  });

  it('uses dev default port when not provided', async () => {
    const program = new Command();
    const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];

    createCodeCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      rawArgv: ['code', '--', '--x'],
      fsImpl: createStubFs(),
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true })) as any,
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

    await program.parseAsync(['node', 'routecodex', 'code', '--', '--x'], { from: 'node' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5555');
  });
});

