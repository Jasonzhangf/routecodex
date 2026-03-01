import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createPortCommand } from '../../src/cli/commands/port.js';

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

describe('cli port command', () => {
  it('rejects unknown subcommand', async () => {
    const out: string[] = [];
    const err: string[] = [];

    const program = new Command();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'port', 'nope'], { from: 'node' })
    ).rejects.toThrow('exit:2');

    expect(err.join('\n')).toContain('Unknown subcommand');
  });

  it('prints listeners when doctor is requested', async () => {
    const out: string[] = [];
    const err: string[] = [];

    const program = new Command();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'port', 'doctor', '5520'], { from: 'node' });

    expect(err.join('\n')).toBe('');
    expect(out.join('\n')).toContain('Port 5520 managed RouteCodex servers:');
    expect(out.join('\n')).toContain('(none)');
  });
});

