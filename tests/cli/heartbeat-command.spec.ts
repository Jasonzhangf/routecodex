import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createHeartbeatCommand } from '../../src/cli/commands/heartbeat.js';

describe('cli heartbeat command', () => {
  it('lists heartbeat states in json mode', async () => {
    const printed: string[] = [];

    const program = new Command();
    createHeartbeatCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
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
      fetch: (async (url: string) => {
        if (url.endsWith('/daemon/heartbeat/list')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                states: [{ tmuxSessionId: 'tmux_hb_1', enabled: true, triggerCount: 2 }]
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

    await program.parseAsync(['node', 'routecodex', 'heartbeat', 'list', '--json'], { from: 'node' });

    const payload = JSON.parse(printed.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.states[0].tmuxSessionId).toBe('tmux_hb_1');
  });

  it('triggers heartbeat dry-run and forwards api key', async () => {
    const printed: string[] = [];
    const postedBodies: Array<Record<string, unknown>> = [];
    const seenHeaders: Array<Record<string, string>> = [];

    const program = new Command();
    createHeartbeatCommand(program, {
      isDevPackage: true,
      defaultDevPort: 5555,
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
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520, apikey: '${ROUTECODEX_HTTP_APIKEY}' } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/daemon/heartbeat') && init?.method === 'POST') {
          seenHeaders.push((init.headers || {}) as Record<string, string>);
          postedBodies.push(JSON.parse(String(init.body || '{}')));
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                tmuxSessionId: 'tmux_hb_2',
                result: { ok: false, reason: 'tmux_session_not_found', disable: true }
              })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: { ROUTECODEX_HTTP_APIKEY: 'test-http-apikey' },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'heartbeat', 'trigger', '--tmux-session-id', 'tmux_hb_2', '--dry-run', '--json'],
      { from: 'node' }
    );

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toEqual({
      action: 'trigger',
      tmuxSessionId: 'tmux_hb_2',
      dryRun: true
    });
    expect(seenHeaders[0]['x-api-key']).toBe('test-http-apikey');

    const payload = JSON.parse(printed.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.result.reason).toBe('tmux_session_not_found');
  });
});
