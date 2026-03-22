import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        if (url === 'http://127.0.0.1:5520/health') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', ready: true }),
            text: async () => JSON.stringify({ status: 'ok', ready: true })
          } as any;
        }
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
        if (url === 'http://127.0.0.1:5520/health') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', ready: true }),
            text: async () => JSON.stringify({ status: 'ok', ready: true })
          } as any;
        }
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

  it('auto-discovers active server port when config/env/default port are missing', async () => {
    const printed: string[] = [];
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-autodiscover-'));
    fs.writeFileSync(path.join(userDir, 'server-5555.pid'), '12345\n', 'utf8');
    const oldRccHome = process.env.RCC_HOME;
    const oldRouteHome = process.env.ROUTECODEX_HOME;
    const oldRouteUserDir = process.env.ROUTECODEX_USER_DIR;
    process.env.RCC_HOME = userDir;
    process.env.ROUTECODEX_HOME = userDir;
    process.env.ROUTECODEX_USER_DIR = userDir;

    try {
      const program = new Command();
      createHeartbeatCommand(program, {
        isDevPackage: false,
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
            userConfig: { httpserver: { host: '127.0.0.1' } },
            providerProfiles: {} as any
          }) as any,
        fetch: (async (url: string) => {
          if (url === 'http://127.0.0.1:5555/health') {
            return {
              ok: true,
              status: 200,
              json: async () => ({ status: 'ok', ready: true }),
              text: async () => JSON.stringify({ status: 'ok', ready: true })
            } as any;
          }
          if (url === 'http://127.0.0.1:5555/daemon/heartbeat/list') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: true, states: [] })
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
    } finally {
      if (oldRccHome === undefined) delete process.env.RCC_HOME;
      else process.env.RCC_HOME = oldRccHome;
      if (oldRouteHome === undefined) delete process.env.ROUTECODEX_HOME;
      else process.env.ROUTECODEX_HOME = oldRouteHome;
      if (oldRouteUserDir === undefined) delete process.env.ROUTECODEX_USER_DIR;
      else process.env.ROUTECODEX_USER_DIR = oldRouteUserDir;
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('queries heartbeat history with limit and tmux session id', async () => {
    const printed: string[] = [];
    const seenUrls: string[] = [];

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
        if (url === 'http://127.0.0.1:5520/health') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', ready: true }),
            text: async () => JSON.stringify({ status: 'ok', ready: true })
          } as any;
        }
        seenUrls.push(url);
        if (url.includes('/daemon/heartbeat/history?')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                tmuxSessionId: 'finger',
                events: [{ action: 'trigger', outcome: 'skipped', reason: 'tmux_session_not_found' }]
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

    await program.parseAsync(
      ['node', 'routecodex', 'heartbeat', 'history', '--tmux-session-id', 'finger', '--limit', '5', '--json'],
      { from: 'node' }
    );

    expect(seenUrls[0]).toContain('/daemon/heartbeat/history?');
    expect(seenUrls[0]).toContain('tmuxSessionId=finger');
    expect(seenUrls[0]).toContain('limit=5');
    const payload = JSON.parse(printed.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.events[0].reason).toBe('tmux_session_not_found');
  });
});
