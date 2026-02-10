import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createCodeCommand } from '../../src/cli/commands/code.js';
import { registerCodeCommand } from '../../src/cli/register/code-command.js';

describe('cli code command', () => {
  it('registers code command', () => {
    const program = new Command();
    registerCodeCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((command) => command.name() === 'code')).toBe(true);
  });

  it('exits with guidance to use rcc claude', async () => {
    const errors: string[] = [];
    const program = new Command();

    createCodeCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: (message) => errors.push(message)
      },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(program.parseAsync(['node', 'routecodex', 'code'], { from: 'node' })).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('rcc claude');
  });
});
