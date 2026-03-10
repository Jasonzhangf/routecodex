import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createSessionInjectCommand } from '../../src/cli/commands/session-inject.js';

describe('cli session-inject command', () => {
  it('lists daemon records in json mode', async () => {
    const printed: string[] = [];
    const info: string[] = [];

    const program = new Command();
    createSessionInjectCommand(program, {
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
        if (url.endsWith('/daemon/session-client/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [
                {
                  daemonId: 'sessiond_1',
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

    await program.parseAsync(['node', 'routecodex', 'session-inject', '--list', '--json'], { from: 'node' });

    expect(info).toHaveLength(0);
    const payload = JSON.parse(printed.join('\n'));
    expect(Array.isArray(payload.records)).toBe(true);
    expect(payload.records[0].daemonId).toBe('sessiond_1');
  });

  it('auto-selects single daemon session for injection', async () => {
    const success: string[] = [];
    const infos: string[] = [];
    const postedBodies: any[] = [];
    const seenHeaders: Array<Record<string, string>> = [];

    const program = new Command();
    createSessionInjectCommand(program, {
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
          userConfig: { httpserver: { host: '127.0.0.1', port: 5520, apikey: '${ROUTECODEX_HTTP_APIKEY}' } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/daemon/session-client/list')) {
          seenHeaders.push((init?.headers || {}) as Record<string, string>);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [{ daemonId: 'sessiond_only', sessionId: 'session_only', tmuxTarget: 'rcc_codex:0.0' }]
            })
          } as any;
        }
        if (url.endsWith('/daemon/session-client/inject')) {
          seenHeaders.push((init?.headers || {}) as Record<string, string>);
          postedBodies.push(JSON.parse(String(init?.body || '{}')));
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, daemonId: 'sessiond_only' })
          } as any;
        }
        throw new Error(`unexpected url: ${url}`);
      }) as any,
      env: { ROUTECODEX_HTTP_APIKEY: 'test-http-apikey' },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'session-inject', '--text', 'hello-from-cli'], { from: 'node' });

    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].tmuxSessionId).toBe('session_only');
    expect(postedBodies[0].sessionId).toBe('session_only');
    expect(postedBodies[0].text).toBe('hello-from-cli');
    expect(seenHeaders[0]['x-api-key']).toBe('test-http-apikey');
    expect(seenHeaders[1]['x-api-key']).toBe('test-http-apikey');
    expect(success.join('\n')).toContain('Injected text to tmux session session_only');
    expect(infos.join('\n')).toContain('only call tools that are available in your current runtime');
  });

  it('fails when multiple daemon sessions exist without explicit target', async () => {
    const errors: string[] = [];

    const program = new Command();
    createSessionInjectCommand(program, {
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
        if (url.endsWith('/daemon/session-client/list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              records: [
                { daemonId: 'sessiond_1', sessionId: 'session_1' },
                { daemonId: 'sessiond_2', sessionId: 'session_2' }
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
      program.parseAsync(['node', 'routecodex', 'session-inject', '--text', 'hello-without-target'], { from: 'node' })
    ).rejects.toThrow('exit:1');

    expect(errors.join('\n')).toContain('Multiple daemon tmux sessions found');
  });
});
