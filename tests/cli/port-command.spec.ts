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

function createFetchResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  } as Response;
}

describe('cli port command', () => {
  it('rejects unknown subcommand', async () => {
    const out: string[] = [];
    const err: string[] = [];

    const program = new Command();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      fetch: async () => createFetchResponse({ ok: true }),
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
      fetch: async () => createFetchResponse({ ok: true }),
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

  it('queries virtual router status via HTTP thin shell', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];

    const program = new Command();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      fetch: async (url: string, init?: RequestInit) => {
        urls.push(`${init?.method ?? 'GET'} ${url}`);
        return createFetchResponse({
          ok: true,
          serverId: 'routecodex:5520',
          virtualRouter: {
            routes: { default: { pools: [{ routeName: 'default' }] } }
          }
        });
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'port', 'status', '5520', '--json'], { from: 'node' });

    expect(err.join('\n')).toBe('');
    expect(urls).toEqual([
      'GET http://127.0.0.1:5520/_routecodex/diagnostics/virtual-router/status'
    ]);
    expect(out.join('\n')).toContain('"serverId":"routecodex:5520"');
    expect(out.join('\n')).toContain('"routeName":"default"');
  });

  it('rejects removed provider probe flag for virtual router status', async () => {
    const err: string[] = [];
    const program = new Command();
    program.exitOverride();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      fetch: async () => createFetchResponse({ ok: true }),
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      log: () => {},
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'port', 'status', '5520', '--probe'], { from: 'node' })
    ).rejects.toThrow("unknown option '--probe'");
  });

  it('dry-runs virtual router decisions via HTTP thin shell', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];

    const program = new Command();
    createPortCommand(program, {
      defaultPort: 5555,
      createSpinner: async () => createStubSpinner(),
      fetch: async (url: string, init?: RequestInit) => {
        urls.push(`${init?.method ?? 'GET'} ${url}`);
        expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
        expect(init?.body).toBe(JSON.stringify({
          request: { messages: [{ role: 'user', content: 'hello' }] },
          metadata: { requestId: 'req-1' }
        }));
        return createFetchResponse({
          ok: true,
          serverId: 'routecodex:5520',
          diagnostics: {
            ok: true,
            decision: { selectedRouteName: 'default', selectedProviderKey: 'sdfv.key1.gpt-test' }
          }
        });
      },
      findListeningPids: () => [],
      killPidBestEffort: () => {},
      sleep: async () => {},
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync([
      'node',
      'routecodex',
      'port',
      'dry-run',
      '5520',
      '--request-json',
      JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
      '--metadata-json',
      JSON.stringify({ requestId: 'req-1' }),
      '--json'
    ], { from: 'node' });

    expect(err.join('\n')).toBe('');
    expect(urls).toEqual([
      'POST http://127.0.0.1:5520/_routecodex/diagnostics/virtual-router/dry-run'
    ]);
    expect(out.join('\n')).toContain('"selectedRouteName":"default"');
    expect(out.join('\n')).toContain('"selectedProviderKey":"sdfv.key1.gpt-test"');
  });
});
