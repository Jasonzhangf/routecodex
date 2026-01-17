import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createExamplesCommand } from '../../src/cli/commands/examples.js';

describe('cli examples command', () => {
  it('prints usage examples', async () => {
    const out: string[] = [];
    const program = new Command();
    createExamplesCommand(program, { log: (line) => out.push(line) });

    await program.parseAsync(['node', 'routecodex', 'examples'], { from: 'node' });

    const text = out.join('\n');
    expect(text).toContain('RouteCodex Usage Examples');
    expect(text).toContain('rcc start');
  });
});

