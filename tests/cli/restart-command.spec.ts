import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

import { createRestartCommand } from '../../src/cli/commands/restart.js';
import { registerRestartCommand } from '../../src/cli/register/restart-command.js';

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

describe('cli restart command', () => {
  it('registers restart command', () => {
    const program = new Command();
    registerRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      sleep: async () => {},
      sendSignal: () => {},
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    expect(program.commands.some((c) => c.name() === 'restart')).toBe(true);
  });

  it('rejects using --codex and --claude together', async () => {
    const program = new Command();
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: () => [],
      sleep: async () => {},
      sendSignal: () => {},
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'restart', '--codex', '--claude'], { from: 'node' })
    ).rejects.toThrow('exit:1');
  });

  it('requests in-place restart for the running server', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5520) {
          return [];
        }
        // first read => existing server pid; subsequent => restarted pid
        return call <= 1 ? [111] : [222];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
          httpserver: { port: 5520, host: '127.0.0.1' },
          virtualrouter: { providers: { tabglm: { id: 'tabglm', enabled: true } } }
        }),
        writeFileSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/') } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart'], { from: 'node' });
    expect(signals).toEqual([{ pid: 111, signal: 'SIGUSR2' }]);
  });

  it('supports --port to target a specific server for in-place restart', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5520) {
          return [];
        }
        return call <= 1 ? [333] : [444];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    expect(signals).toEqual([{ pid: 333, signal: 'SIGUSR2' }]);
  });

  it('uses direct signal restart when local pid is known and no restart apikey is configured', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fetchCalls: string[] = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5520) {
          return [];
        }
        return call <= 1 ? [345] : [456];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/health')) {
        return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        if (String(url).includes('/daemon/restart-process')) {
          throw new Error('should not call daemon restart endpoint without apikey when local pid is known');
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    expect(signals).toEqual([{ pid: 345, signal: 'SIGUSR2' }]);
    expect(fetchCalls.some((url) => url.includes('/daemon/restart-process'))).toBe(false);
  });

  it('still signals restart for --port when health probe is temporarily unavailable', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let healthCall = 0;
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5520) {
          return [];
        }
        return call <= 1 ? [555] : [666];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (!String(url).includes('/health')) {
          return { ok: false, status: 404, text: async () => '' } as any;
        }
        healthCall += 1;
        if (healthCall <= 2) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) };
      }) as any,
      env: {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    expect(signals).toEqual([{ pid: 555, signal: 'SIGUSR2' }]);
  });

  it('accepts same-pid healthy restart without timing out via in-place signal', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => (port === 5520 ? [777] : []),
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () =>
          JSON.stringify({
            httpserver: { port: 5520, host: '127.0.0.1' },
            virtualrouter: { providers: { tabglm: { id: 'tabglm', enabled: true } } }
          }),
        writeFileSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/') } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart'], { from: 'node' });
    expect(signals).toEqual([{ pid: 777, signal: 'SIGUSR2' }]);
  });

  it('sends the config-managed http apikey to daemon restart endpoint', async () => {
    const program = new Command();
    const fetchCalls: Array<{ url: string; options?: Record<string, unknown> }> = [];
    let findCall = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        findCall += 1;
        if (port !== 5520) {
          return [];
        }
        return findCall <= 1 ? [901] : [901];
      },
      sleep: async () => {},
      sendSignal: () => {
        throw new Error('should not fall back to SIGUSR2 when restart endpoint accepts apikey');
      },
      fetch: (async (url: string, options?: Record<string, unknown>) => {
        fetchCalls.push({ url, options });
        if (String(url).includes('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true })
          } as any;
        }
        if (String(url).includes('/daemon/restart-process')) {
          return {
            ok: true,
            status: 202,
            text: async () => '',
            json: async () => ({ ok: true, accepted: true })
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {
        ROUTECODEX_HTTP_APIKEY: 'shared-http-key'
      },
      fsImpl: {
        existsSync: () => true,
        readFileSync: () =>
          '[httpserver]\nport = 5520\nhost = "127.0.0.1"\napikey = "${ROUTECODEX_HTTP_APIKEY}"\n'
      } as any,
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    const restartCall = fetchCalls.find((entry) => String(entry.url).includes('/daemon/restart-process'));
    expect(restartCall).toBeDefined();
    expect(restartCall?.options?.headers).toEqual({ 'x-api-key': 'shared-http-key' });
  });

  it('does not let ambient http apikey force restart endpoint when config explicitly disables apikey', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fetchCalls: string[] = [];
    let findCall = 0;
    createRestartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        findCall += 1;
        if (port !== 5520) {
          return [];
        }
        return findCall <= 1 ? [1001] : [1002];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        if (String(url).includes('/daemon/restart-process')) {
          throw new Error('should not call daemon restart endpoint when config apikey is explicitly empty');
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {
        ROUTECODEX_HTTP_APIKEY: 'ambient-http-key'
      },
      fsImpl: {
        existsSync: () => true,
        readFileSync: () =>
          JSON.stringify({
            httpserver: { port: 5520, host: '127.0.0.1', apikey: '' }
          })
      } as any,
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' });
    expect(signals).toEqual([{ pid: 1001, signal: 'SIGUSR2' }]);
    expect(fetchCalls.some((url) => url.includes('/daemon/restart-process'))).toBe(false);
  });

  it('uses configured member hosts for aggregate restart probes', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fetchCalls: string[] = [];
    let restarted = false;

    createRestartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        if (![5520, 10000].includes(port)) {
          return [];
        }
        return restarted ? [702] : [701];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        restarted = true;
      },
      fetch: (async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('127.0.0.1:10000/health')) {
          throw new Error('restart must not probe top-level loopback host for 10000 multi-port target');
        }
        if (String(url).includes(':10000/health') || String(url).includes(':5520/health')) {
          return { ok: true, status: 200, json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true }) } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => [
          '[httpserver]',
          'host = "127.0.0.1"',
          'port = 5520',
          '',
          '[[httpserver.ports]]',
          'port = 5520',
          'host = "0.0.0.0"',
          'mode = "router"',
          'routingPolicyGroup = "gateway_priority_5520"',
          '',
          '[[httpserver.ports]]',
          'port = 10000',
          'host = "0.0.0.0"',
          'mode = "router"',
          'routingPolicyGroup = "gateway_coding_10000"',
          ''
        ].join('\n'),
        writeFileSync: () => {}
      } as any,
      pathImpl: { join: (...parts: string[]) => parts.join('/') } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '10000'], { from: 'node' });

    expect(fetchCalls.some((url) => url.includes('127.0.0.1:10000/health'))).toBe(false);
    expect(signals).toEqual([{ pid: 701, signal: 'SIGUSR2' }]);
  });

  it('restarts one aggregate instance once and verifies every configured member port', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const healthPorts = new Set<number>();
    let restarted = false;

    createRestartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        if (![4444, 5520, 5555, 10000].includes(port)) {
          return [];
        }
        return restarted ? [802] : [801];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        restarted = true;
      },
      fetch: (async (url: string) => {
        const match = String(url).match(/:(\d+)\/health/);
        if (match) {
          healthPorts.add(Number(match[1]));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              server: 'routecodex',
              status: 'ok',
              ready: true,
              pipelineReady: true
            })
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => [
          '[httpserver]',
          'host = "127.0.0.1"',
          'port = 5520',
          '',
          '[[httpserver.ports]]',
          'port = 5520',
          'host = "0.0.0.0"',
          '',
          '[[httpserver.ports]]',
          'port = 5555',
          'host = "0.0.0.0"',
          '',
          '[[httpserver.ports]]',
          'port = 10000',
          'host = "0.0.0.0"',
          '',
          '[[httpserver.ports]]',
          'port = 4444',
          'host = "0.0.0.0"',
          ''
        ].join('\n')
      } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5555'], { from: 'node' });

    expect(signals).toEqual([{ pid: 801, signal: 'SIGUSR2' }]);
    expect(Array.from(healthPorts).sort((a, b) => a - b)).toEqual([4444, 5520, 5555, 10000]);
  });

  it('rejects configured aggregate members owned by different listener identities', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    createRestartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        if (port === 5520) {
          return [901];
        }
        if (port === 5555) {
          return [902];
        }
        return [];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              server: 'routecodex',
              status: 'ok',
              ready: true,
              pipelineReady: true
            })
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => [
          '[httpserver]',
          'port = 5520',
          'host = "127.0.0.1"',
          '',
          '[[httpserver.ports]]',
          'port = 5520',
          '',
          '[[httpserver.ports]]',
          'port = 5555',
          ''
        ].join('\n')
      } as any,
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'restart', '--port', '5520'], { from: 'node' })
    ).rejects.toThrow('exit:1');
    expect(signals).toEqual([]);
  });

  it('groups discovered ports with the same listener identity without --port', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let restarted = false;

    createRestartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5520,
      createSpinner: async () => createStubSpinner(),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        if (![5520, 5555].includes(port)) {
          return [];
        }
        return restarted ? [1002] : [1001];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        restarted = true;
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              server: 'routecodex',
              status: 'ok',
              ready: true,
              pipelineReady: true
            })
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      env: {},
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => [
          '[httpserver]',
          'port = 5520',
          'host = "127.0.0.1"',
          '',
          '[[httpserver.ports]]',
          'port = 5520',
          '',
          '[[httpserver.ports]]',
          'port = 5555',
          ''
        ].join('\n'),
        readdirSync: () => [],
        statSync: () => ({ isDirectory: () => false })
      } as any,
      getHomeDir: () => '/home/test',
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'restart'], { from: 'node' });
    expect(signals).toEqual([{ pid: 1001, signal: 'SIGUSR2' }]);
  });

  it('requests in-session restart when live version lags behind current release', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const failMessages: string[] = [];
    let call = 0;
    createRestartCommand(program, {
      isDevPackage: false,
      isWindows: false,
      defaultDevPort: 5555,
      createSpinner: async () => ({
        ...createStubSpinner(),
        fail: (text?: string) => {
          failMessages.push(String(text || ''));
        }
      }),
      logger: { info: () => {}, error: () => {} },
      findListeningPids: (port) => {
        call += 1;
        if (port !== 5555) {
          return [];
        }
        return call <= 1 ? [71641] : [81641];
      },
      sleep: async () => {},
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      fetch: (async (url: string) => {
        if (String(url).includes('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ server: 'routecodex', status: 'ok', ready: true, pipelineReady: true, version: '0.90.3591' })
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => [
          '[httpserver]',
          'port = 5555',
          'host = "127.0.0.1"',
          ''
        ].join('\n')
      } as any,
      env: {
        npm_package_version: '0.90.3595'
      },
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    try {
      await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5555'], { from: 'node' });
    } catch (error) {
      throw new Error(`${String(error)} :: ${failMessages.join(' | ')}`);
    }

    expect(signals).toEqual([{ pid: 71641, signal: 'SIGUSR2' }]);
  });

  it('accepts native V3 health body for restart readiness', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const nativeRestarts: Array<{ configPath: string; timeoutMs: number }> = [];
    let restarted = false;
    let fakeNow = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      createRestartCommand(program, {
        isDevPackage: true,
        isWindows: false,
        defaultDevPort: 5555,
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, error: () => {} },
        findListeningPids: (port) => {
          if (port !== 5555) {
            return [];
          }
          return restarted ? [1202] : [1201];
        },
        sleep: async (ms) => {
          fakeNow += Math.max(1, ms);
        },
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
          restarted = true;
        },
        runNativeV3Restart: async (request) => {
          nativeRestarts.push({
            configPath: request.configPath,
            timeoutMs: request.timeoutMs
          });
          restarted = true;
          return { ok: true, stdout: '{"state":"running"}\n', stderr: '' };
        },
        fetch: (async (url: string) => {
          if (String(url).includes('/health')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                bind: '0.0.0.0',
                manifest_version: 3,
                port: 5555,
                server_id: 'responses_v3_5555',
                status: 'ok',
                version: 3
              })
            } as any;
          }
          return { ok: false, status: 404, text: async () => '' } as any;
        }) as any,
        fsImpl: {
          existsSync: (target: string) => (
            String(target).includes('/state/v3-runtime')
            || String(target).endsWith('/instance.json')
            || String(target).endsWith('/status.json')
            || String(target) === '/tmp/config.v3.toml'
          ),
          readdirSync: () => ['v3-current'],
          statSync: () => ({ isDirectory: () => true, mtimeMs: 1234 }),
          readFileSync: (target: string) => {
            if (String(target).endsWith('/instance.json')) {
              return JSON.stringify({
                schema_version: 1,
                instance_id: 'v3-current',
                config_path: '/tmp/config.v3.toml',
                config_digest: 'digest',
                executable_path: '/tmp/rccv3',
                listeners: [{ server_id: 'responses_v3_5555', bind: '0.0.0.0', port: 5555 }]
              });
            }
            if (String(target).endsWith('/status.json')) {
              return JSON.stringify({
                schema_version: 1,
                instance_id: 'v3-current',
                state: 'running',
                updated_at_epoch_ms: 2000,
                detail: null
              });
            }
            return '';
          }
        } as any,
        getHomeDir: () => '/home/test',
        env: { ROUTECODEX_RESTART_WAIT_MS: '5000' },
        exit: (code) => {
          throw new Error(`exit:${code}`);
        }
      });

      await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5555'], { from: 'node' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(nativeRestarts).toEqual([{ configPath: '/tmp/config.v3.toml', timeoutMs: 5000 }]);
  });

  it('rejects native V3 health without lifecycle registry instead of legacy signal restart', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const errors: string[] = [];
    let fakeNow = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      createRestartCommand(program, {
        isDevPackage: true,
        isWindows: false,
        defaultDevPort: 5555,
        createSpinner: async () => createStubSpinner(),
        logger: {
          info: () => {},
          error: (msg) => {
            errors.push(msg);
          }
        },
        findListeningPids: (port) => (port === 5555 ? [1401] : []),
        sleep: async (ms) => {
          fakeNow += Math.max(1, ms);
        },
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
        },
        fetch: (async (url: string) => {
          if (String(url).includes('/health')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                bind: '0.0.0.0',
                manifest_version: 3,
                port: 5555,
                server_id: 'responses_v3_5555',
                status: 'ok',
                version: 3
              })
            } as any;
          }
          return { ok: false, status: 404, text: async () => '' } as any;
        }) as any,
        fsImpl: {
          existsSync: () => false,
          readdirSync: () => [],
          statSync: () => ({ isDirectory: () => false }),
          readFileSync: () => ''
        } as any,
        getHomeDir: () => '/home/test',
        env: { ROUTECODEX_RESTART_WAIT_MS: '5000' },
        exit: (code) => {
          throw new Error(`exit:${code}`);
        }
      });

      await expect(
        program.parseAsync(['node', 'routecodex', 'restart', '--port', '5555'], { from: 'node' })
      ).rejects.toThrow('exit:1');
    } finally {
      nowSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(errors).toContain('Refusing to restart a native V3 listener through legacy signal transport.');
  });

  it('recovers native V3 restart from lifecycle registry when the listener is absent', async () => {
    const program = new Command();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const nativeRestarts: Array<{ configPath: string; timeoutMs: number }> = [];
    let restarted = false;
    let fakeNow = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      createRestartCommand(program, {
        isDevPackage: false,
        isWindows: false,
        defaultDevPort: 5555,
        createSpinner: async () => createStubSpinner(),
        logger: { info: () => {}, error: () => {} },
        findListeningPids: (port) => {
          if (port !== 5555) {
            return [];
          }
          return restarted ? [1302] : [];
        },
        sleep: async (ms) => {
          fakeNow += Math.max(1, ms);
        },
        sendSignal: (pid, signal) => {
          signals.push({ pid, signal });
        },
        runNativeV3Restart: async (request) => {
          nativeRestarts.push({
            configPath: request.configPath,
            timeoutMs: request.timeoutMs
          });
          restarted = true;
          return { ok: true, stdout: '{"state":"running"}\n', stderr: '' };
        },
        fetch: (async (url: string) => {
          if (String(url).includes('/health') && restarted) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                bind: '0.0.0.0',
                manifest_version: 3,
                port: 5555,
                server_id: 'responses_v3_5555',
                status: 'ok',
                version: 3
              })
            } as any;
          }
          if (String(url).includes('/health')) {
            throw new Error('listener absent');
          }
          return { ok: false, status: 404, text: async () => '' } as any;
        }) as any,
        fsImpl: {
          existsSync: (target: string) => (
            String(target).includes('/state/v3-runtime')
            || String(target).endsWith('/instance.json')
            || String(target).endsWith('/status.json')
            || String(target) === '/tmp/config.v3.toml'
          ),
          readdirSync: () => ['v3-current'],
          statSync: () => ({ isDirectory: () => true, mtimeMs: 1234 }),
          readFileSync: (target: string) => {
            if (String(target).endsWith('/instance.json')) {
              return JSON.stringify({
                schema_version: 1,
                instance_id: 'v3-current',
                config_path: '/tmp/config.v3.toml',
                config_digest: 'digest',
                executable_path: '/tmp/rccv3',
                listeners: [{ server_id: 'responses_v3_5555', bind: '0.0.0.0', port: 5555 }]
              });
            }
            if (String(target).endsWith('/status.json')) {
              return JSON.stringify({
                schema_version: 1,
                instance_id: 'v3-current',
                state: 'running',
                updated_at_epoch_ms: 2000,
                detail: null
              });
            }
            return '';
          }
        } as any,
        getHomeDir: () => '/home/test',
        env: { ROUTECODEX_RESTART_WAIT_MS: '5000' },
        exit: (code) => {
          throw new Error(`exit:${code}`);
        }
      });

      await program.parseAsync(['node', 'routecodex', 'restart', '--port', '5555'], { from: 'node' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(signals).toEqual([]);
    expect(nativeRestarts).toEqual([{ configPath: '/tmp/config.v3.toml', timeoutMs: 5000 }]);
  });
});
