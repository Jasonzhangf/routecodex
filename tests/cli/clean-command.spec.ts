import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createCleanCommand } from '../../src/cli/commands/clean.js';

describe('cli clean command', () => {
  it('requires --yes and does not delete by default', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    const success: string[] = [];

    const program = new Command();
    createCleanCommand(program, {
      logger: {
        info: (msg) => info.push(msg),
        warning: (msg) => warn.push(msg),
        success: (msg) => success.push(msg)
      },
      fsImpl: {
        existsSync: () => {
          throw new Error('should not touch filesystem without --yes');
        },
        readdirSync: () => [],
        rmSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'clean'], { from: 'node' });

    expect(warn.join('\n')).toContain('--yes');
    expect(success.join('\n')).toBe('');
  });
});

