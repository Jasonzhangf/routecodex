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
    const lanHost = '192.168.50.10';
    const failMessages: string[] = [];
    await jest.unstable_mockModule('../../src/utils/local-connect-host.js', () => ({
      buildLocalProbeHostCandidates: (host: string) => (
        String(host).trim() === '0.0.0.0'
          ? [lanHost, '127.0.0.1']
          : [String(host)]
      ),
      resolvePreferredLocalConnectHost: (host: string) => (
        String(host).trim() === '0.0.0.0' ? lanHost : String(host)
      )
    }));

    const { createRestartCommand } = await import('../../src/cli/commands/restart.js');
    const fetchCalls: string[] = [];
    let fetchCount = 0;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let restarted = false;
    const program = new Command();
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 10000,
      createSpinner: async () => ({
        ...createStubSpinner(),
        fail: (text: string) => {
          failMessages.push(text);
        }
      }),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        if (port !== 10000) {
          return [];
        }
        return restarted ? [902] : [901];
      },
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 0)),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        fetchCount += 1;
        fetchCalls.push(String(url));
        if (fetchCalls.length > 10) {
          fetchCalls.shift();
        }
        if (String(url).includes('/daemon/restart-process')) {
          restarted = true;
          return { ok: true, status: 204, text: async () => '' } as any;
        }
        if (String(url).includes(`${lanHost}:10000/health`)) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              server: 'routecodex',
              status: 'ok',
              ready: true,
              pipelineReady: true
            })
          } as any;
        }
        if (String(url).includes('/health')) {
          return { ok: false, status: 503, text: async () => JSON.stringify({ server: 'other', status: 'bad' }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: { ROUTECODEX_HTTP_APIKEY: 'sk-test' },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    try {
      await program.parseAsync(['node', 'routecodex', 'restart', '--port', '10000', '--host', '0.0.0.0'], { from: 'node' });
    } catch (error) {
      throw new Error(`${String(error)} :: ${failMessages.join(' | ')} :: count=${fetchCount} :: recent=${fetchCalls.join(' || ')}`);
    }

    expect(fetchCalls.some((url) => url.includes(`${lanHost}:10000/health`))).toBe(true);
    expect(signals).toEqual([{ pid: 901, signal: 'SIGUSR2' }]);
  }, 20_000);
});
