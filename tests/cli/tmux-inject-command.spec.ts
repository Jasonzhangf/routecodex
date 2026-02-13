import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createTmuxInjectCommand } from '../../src/cli/commands/tmux-inject.js';

describe('cli tmux-inject command', () => {
  it('lists daemon records in json mode', async () => {
    const printed: string[] = [];
    const info: string[] = [];

    const program = new Command();
    createTmuxInjectCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
      logger: {
        info: (msg) => info.push(msg),
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
      fetch: (async (url: string) => {
        if (url.endsWith('/daemon/clock-client/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [
                {
                  daemonId: 'clockd_1',
                  sessionId: 's_1',
                  tmuxTarget: 'rcc_codex_1:0.0',
                  lastHeartbeatAtMs: 1770772000000
                }
              ]
            })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'tmux-inject', '--list', '--json'], { from: 'node' });

    expect(info).toHaveLength(0);
    const payload = JSON.parse(printed.join('\n'));
    expect(Array.isArray(payload.records)).toBe(true);
    expect(payload.records[0].daemonId).toBe('clockd_1');
  });

  it('auto-selects single daemon session for injection', async () => {
    const success: string[] = [];
    const infos: string[] = [];
    const postedBodies: any[] = [];

    const program = new Command();
    createTmuxInjectCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: (msg) => success.push(msg),
        error: () => {}
      },
      log: () => {},
      loadConfig: async () =>
        ({
          configPath: '/tmp/config.json',
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520 } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/daemon/clock-client/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [{ daemonId: 'clockd_only', sessionId: 'session_only', tmuxTarget: 'rcc_codex:0.0' }]
            })
          } as any;
        }
        if (url.endsWith('/daemon/clock-client/inject')) {
          postedBodies.push(JSON.parse(String(init?.body || '{}')));
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, daemonId: 'clockd_only' })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'tmux-inject', '--text', 'hello-from-cli'], { from: 'node' });

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].tmuxSessionId).toBe('session_only');
    expect(postedBodies[0].sessionId).toBe('session_only');
    expect(postedBodies[0].text).toBe('hello-from-cli');
    expect(success.join('\n')).toContain('Injected text to tmux session session_only');
    expect(infos.join('\n')).toContain('only call tools that are available in your current runtime');
  });

  it('fails when multiple daemon sessions exist without explicit target', async () => {
    const errors: string[] = [];

    const program = new Command();
    createTmuxInjectCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: (msg) => errors.push(msg)
      },
      log: () => {},
      loadConfig: async () =>
        ({
          configPath: '/tmp/config.json',
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520 } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async (url: string) => {
        if (url.endsWith('/daemon/clock-client/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [
                { daemonId: 'clockd_1', sessionId: 'session_1' },
                { daemonId: 'clockd_2', sessionId: 'session_2' }
              ]
            })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'tmux-inject', '--text', 'hello-without-target'], { from: 'node' })
    ).rejects.toThrow('exit:1');

    expect(errors.join('\n')).toContain('Multiple daemon tmux sessions found');
  });
});
