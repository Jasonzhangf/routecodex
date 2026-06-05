import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

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

describe('cli restart command probe host resolution', () => {
  it('prefers resolved LAN probe host for wildcard bind targets', async () => {
    jest.resetModules();
    await jest.unstable_mockModule('../../src/utils/local-connect-host.js', () => ({
      buildLocalProbeHostCandidates: (host: string) => (
        String(host).trim() === '0.0.0.0'
          ? ['192.168.50.10', '127.0.0.1']
          : [String(host)]
      ),
      resolvePreferredLocalConnectHost: (host: string) => (
        String(host).trim() === '0.0.0.0' ? '192.168.50.10' : String(host)
      )
    }));

    const { createRestartCommand } = await import('../../src/cli/commands/restart.js');
    const fetchCalls: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let call = 0;
    const program = new Command();
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 10000,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 10000) {
          return [];
        }
        return call <= 1 ? [901] : [902];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('192.168.50.10:10000/health')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ server: 'routecodex', status: 'ok' }) } as any;
        }
        if (String(url).includes('/health')) {
          return { ok: false, status: 503, text: async () => JSON.stringify({ server: 'other', status: 'bad' }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '10000', '--host', '0.0.0.0'], { from: 'node' });

    expect(fetchCalls.some((url) => url.includes('192.168.50.10:10000/health'))).toBe(true);
    expect(signals).toEqual([{ pid: 901, signal: 'SIGUSR2' }]);
  });
});
