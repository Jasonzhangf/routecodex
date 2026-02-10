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

describe('cli codex command', () => {
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
});
