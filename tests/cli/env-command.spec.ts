import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createEnvCommand } from '../../src/cli/commands/env.js';

describe('cli env command', () => {
  it('parses args and prints shell exports', async () => {
    const out: string[] = [];
    const err: string[] = [];

    const program = new Command();
    createEnvCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'env', '--host', 'localhost', '--port', '5520'], { from: 'node' });

    expect(err.join('\n')).toBe('');
    const text = out.join('\n');
    expect(text).toContain('export ANTHROPIC_BASE_URL=http://127.0.0.1:5520');
    expect(text).toContain('unset ANTHROPIC_TOKEN');
  });
});

