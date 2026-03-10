import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createSessionAdminCommand } from '../../src/cli/commands/session-admin.js';

describe('cli session-admin command', () => {
  it('lists session tasks by default', async () => {
    const printed: string[] = [];

    const program = new Command();
    createSessionAdminCommand(program, {
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
        if (url.endsWith('/daemon/session/tasks')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, sessions: [] })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'session-admin', '--json'], { from: 'node' });

    const payload = JSON.parse(printed.join('\n'));
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.sessions)).toBe(true);
  });

  it('creates recurring session task', async () => {
    const printed: string[] = [];
    const postedBodies: Array<Record<string, unknown>> = [];
    const postedHeaders: Array<Record<string, string>> = [];

    const program = new Command();
    createSessionAdminCommand(program, {
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
        if (url.endsWith('/daemon/session/tasks') && init?.method === 'POST') {
          postedHeaders.push((init.headers || {}) as Record<string, string>);
          postedBodies.push(JSON.parse(String(init.body || '{}')));
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true, scheduledCount: 1 })
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
      [
        'node', 'routecodex', 'session-admin',
        '--create',
        '--session-id', 'conv_1',
        '--due-at', '2026-02-11T10:00:00Z',
        '--task', 'hello',
        '--recurrence', 'interval',
        '--every-minutes', '15',
        '--max-runs', '8',
        '--json'
      ],
      { from: 'node' }
    );

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].sessionId).toBe('conv_1');
    expect((postedBodies[0].recurrence as any)?.kind).toBe('interval');
    expect((postedBodies[0].recurrence as any)?.everyMinutes).toBe(15);
    expect((postedBodies[0].recurrence as any)?.maxRuns).toBe(8);
    expect(postedHeaders[0]['x-api-key']).toBe('test-http-apikey');

    const payload = JSON.parse(printed.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.scheduledCount).toBe(1);
  });
});
