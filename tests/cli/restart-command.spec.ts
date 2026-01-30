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

  it('auto-enables --claude when tabglm provider exists in config', async () => {
    const program = new Command();
    let capturedEnv: Record<string, string> | undefined;
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
      spawn: (_cmd, _args, options) => {
        capturedEnv = options.env as any;
        return ({ pid: 123, on: () => {}, kill: () => true } as any);
      },
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
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
    expect(capturedEnv?.ROUTECODEX_SYSTEM_PROMPT_ENABLE).toBe('1');
    expect(capturedEnv?.ROUTECODEX_SYSTEM_PROMPT_SOURCE).toBe('claude');
  });
});
