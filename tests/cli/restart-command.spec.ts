import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createRestartCommand } from '../../src/cli/commands/restart.js';

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
  it('rejects using --codex and --claude together', async () => {
    const program = new Command();
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      nodeBin: 'node',
      spawn: () => ({ pid: 123, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'restart', '--codex', '--claude'], { from: 'node' })
    ).rejects.toThrow('exit:1');
  });
});

