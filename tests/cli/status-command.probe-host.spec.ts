import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

describe('cli status command probe host resolution', () => {
  it('uses resolved LAN probe host for wildcard bind config', async () => {
    jest.resetModules();
    await jest.unstable_mockModule('../../src/utils/local-connect-host.js', () => ({
      buildLocalProbeHostCandidates: (host: string) => (
        String(host).trim() === '0.0.0.0'
          ? ['192.168.50.10', '127.0.0.1']
          : [String(host)]
      )
    }));

    const { createStatusCommand } = await import('../../src/cli/commands/status.js');
    const success: string[] = [];
    const fetchCalls: string[] = [];
    const program = new Command();

    createStatusCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: (msg) => success.push(msg),
        error: () => {}
      },
      log: () => {},
      loadConfig: async () =>
        ({
          configPath: '/tmp/config.json',
          userConfig: { httpserver: { host: '0.0.0.0', port: 10000 } },
          providerProfiles: {} as any
        }) as any,
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('192.168.50.10:10000/health')) {
          return { ok: true, json: async () => ({ status: 'healthy', version: 'test' }) } as any;
        }
        throw new Error('unexpected probe host');
      }) as any,
      listManagedZombieChildren: () => []
    });

    await program.parseAsync(['node', 'routecodex', 'status'], { from: 'node' });

    expect(fetchCalls[0]).toContain('192.168.50.10:10000/health');
    expect(success.join('\n')).toContain('Server is running on 192.168.50.10:10000');
  });
});
