import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

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
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'stop'], { from: 'node' });
    expect(succeeded.join('\n')).toContain('No server listening on 5520');
  });
});
