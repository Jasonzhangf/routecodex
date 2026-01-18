import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createStartCommand } from '../../src/cli/commands/start.js';
import { registerStartCommand } from '../../src/cli/register/start-command.js';

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

describe('cli start command', () => {
  it('registers start command', () => {
    const program = new Command();
    registerStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((c) => c.name() === 'start')).toBe(true);
  });

  it('rejects using --codex and --claude together', async () => {
    const program = new Command();
    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'start', '--codex', '--claude'], { from: 'node' })
    ).rejects.toThrow('exit:1');
  });

  it('exits when config is missing', async () => {
    const errors: string[] = [];
    const program = new Command();
    createStartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      nodeBin: 'node',
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      env: {},
      fsImpl: {
        existsSync: () => false,
        statSync: () => ({ isDirectory: () => false } as any),
        readFileSync: () => '{}',
        writeFileSync: () => {},
        mkdtempSync: () => '/tmp/rc',
        mkdirSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/'), resolve: (...parts: string[]) => parts.join('/') } as any,
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      sleep: async () => {},
      ensureLocalTokenPortalEnv: async () => {},
      ensureTokenDaemonAutoStart: async () => {},
      ensurePortAvailable: async () => {},
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      spawn: () => ({ pid: 1, on: () => {}, kill: () => true } as any),
      fetch: (async () => ({ ok: true })) as any,
      setupKeypress: () => () => {},
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'rcc', 'start'], { from: 'node' })).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('Please create a RouteCodex user config');
  });
});
