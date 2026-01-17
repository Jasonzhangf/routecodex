import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createStatusCommand } from '../../src/cli/commands/status.js';

describe('cli status command', () => {
  it('prints running when /health is healthy', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    const success: string[] = [];
    const error: string[] = [];

    const program = new Command();
    createStatusCommand(program, {
      logger: {
        info: (msg) => info.push(msg),
        warning: (msg) => warn.push(msg),
        success: (msg) => success.push(msg),
        error: (msg) => error.push(msg)
      },
      log: () => {},
      loadConfig: async () =>
        ({
          configPath: '/tmp/config.json',
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520 } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async () =>
        ({
          ok: true,
          json: async () => ({ status: 'healthy' })
        }) as any) as any
    });

    await program.parseAsync(['node', 'routecodex', 'status'], { from: 'node' });

    expect(error.join('\n')).toBe('');
    expect(success.join('\n')).toContain('Server is running on 127.0.0.1:5520');
    expect(warn.join('\n')).toBe('');
  });

  it('prints json when --json is set', async () => {
    const printed: string[] = [];
    const program = new Command();
    createStatusCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      log: (line) => printed.push(line),
      loadConfig: async () =>
        ({
          configPath: '/tmp/config.json',
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520 } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async () =>
        ({
          ok: true,
          json: async () => ({ status: 'healthy' })
        }) as any) as any
    });

    await program.parseAsync(['node', 'routecodex', 'status', '--json'], { from: 'node' });

    const text = printed.join('\n');
    const parsed = JSON.parse(text);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(5520);
  });
});

