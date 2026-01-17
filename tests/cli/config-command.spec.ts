import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createConfigCommand } from '../../src/cli/commands/config.js';

describe('cli config command', () => {
  it('validate reports invalid json', async () => {
    const errors: string[] = [];
    const success: string[] = [];

    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: (msg) => success.push(msg),
        error: (msg) => errors.push(msg)
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => '{ not-json',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'validate', '--config', '/tmp/config.json'], { from: 'node' });

    expect(success.join('\n')).toBe('');
    expect(errors.join('\n')).toContain('Configuration is invalid');
  });

  it('show prints config when file exists', async () => {
    const printed: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ server: { port: 5520 } }),
        writeFileSync: () => {},
        mkdirSync: () => {}
      },
      log: (line) => printed.push(line)
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'show', '--config', '/tmp/config.json'], { from: 'node' });

    const parsed = JSON.parse(printed.join('\n'));
    expect(parsed.server.port).toBe(5520);
  });
});

