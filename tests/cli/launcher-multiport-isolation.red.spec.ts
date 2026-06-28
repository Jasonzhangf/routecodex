import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createCodexCommand } from '../../src/cli/commands/codex.js';
import { createStartCommand } from '../../src/cli/commands/start.js';

function spinner() {
  return { start: () => spinner(), succeed: () => {}, fail: () => {}, warn: () => {}, info: () => {}, stop: () => {}, text: '' };
}

describe('launcher multi-port isolation red tests', () => {
  it('does not bind a multi-port server process to one port log file', async () => {
    const configPath = '/configs/multi.json';
    const configContent = JSON.stringify({
      httpserver: {
        host: '127.0.0.1',
        port: 5520,
        ports: [
          { port: 5520, mode: 'router', routingPolicyGroup: 'gateway_priority_5520' },
          { port: 5555, mode: 'router', routingPolicyGroup: 'gateway_priority_5555' }
        ]
      }
    });
    const openedLogs: string[] = [];
    const spawnCalls: Array<{ options: any }> = [];
    let readyChecks = 0;

    const program = new Command();
    createCodexCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => spinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (message: unknown) => { throw new Error(`logger-error:${String(message)}`); } },
      env: { ROUTECODEX_SESSION_RECLAIM_REQUIRED: '0' },
      rawArgv: ['codex', '--config', configPath, '--port', '5555', '--', '--help'],
      fsImpl: {
        existsSync: (target: string) => target === configPath,
        readFileSync: (target: string) => (target === configPath ? configContent : ''),
        mkdirSync: () => undefined,
        openSync: (target: string) => {
          openedLogs.push(target);
          return 55;
        },
        closeSync: () => undefined,
        writeFileSync: () => undefined,
        unlinkSync: () => undefined,
        renameSync: () => undefined,
        statSync: () => ({ size: 0 })
      } as any,
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async (url: string) => {
        if (url.endsWith('/ready') || url.endsWith('/health')) {
          readyChecks += 1;
          return readyChecks > 99
            ? ({ ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) } as any)
            : ({ ok: false, status: 503, json: async () => ({}) } as any);
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }) as any,
      spawn: (_command, _args, options) => {
        spawnCalls.push({ options });
        return { pid: 12345, on: () => {}, once: () => {}, unref: () => {} } as any;
      },
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'routecodex', 'codex', '--config', configPath, '--port', '5555', '--', '--help'], { from: 'node' });

    const serverSpawn = spawnCalls.find((call) => call.options?.env?.ROUTECODEX_CONFIG_PATH === configPath);
    expect(openedLogs).not.toContain('/home/test/.rcc/log/multi/server-5555.log');
    expect(serverSpawn?.options.env.ROUTECODEX_PORT_LOG_ROOT).toBe('/home/test/.rcc/log/multi/ports');
  });

  it('injects the same port log root when starting a multi-port server directly', async () => {
    const configPath = '/configs/multi.json';
    const configContent = JSON.stringify({
      httpserver: {
        host: '127.0.0.1',
        port: 5520,
        ports: [
          { port: 5520, mode: 'router', routingPolicyGroup: 'gateway_priority_5520' },
          { port: 5555, mode: 'router', routingPolicyGroup: 'gateway_priority_5555' }
        ]
      }
    });
    const spawnCalls: Array<{ options: any }> = [];
    const program = new Command();
    createStartCommand(program, {
      isDevPackage: true,
      isWindows: false,
      defaultDevPort: 5555,
      nodeBin: 'node',
      createSpinner: async () => spinner(),
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      env: {},
      fsImpl: {
        existsSync: (target: string) => target === configPath || target === '/tmp/index.js' || target === '/tmp/modules.json',
        statSync: () => ({ isDirectory: () => false }),
        readFileSync: (target: string) => (target === configPath ? configContent : ''),
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        createWriteStream: () => ({ write: () => true, end: () => undefined })
      } as any,
      homedir: () => '/home/test',
      sleep: async () => {},
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', ready: true }) })) as any,
      spawn: (_command, _args, options) => {
        spawnCalls.push({ options });
        return { pid: 12345, on: () => {}, once: () => {}, kill: () => true } as any;
      },
      ensurePortAvailable: async () => undefined,
      ensureLocalTokenPortalEnv: async () => undefined,
      getModulesConfigPath: () => '/tmp/modules.json',
      resolveServerEntryPath: () => '/tmp/index.js',
      setupKeypress: () => () => undefined,
      onSignal: () => undefined,
      waitForever: async () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    } as any);

    await program.parseAsync(['node', 'routecodex', 'start', '--config', configPath, '--port', '5555'], { from: 'node' });

    expect(spawnCalls[0]?.options.env.ROUTECODEX_PORT_LOG_ROOT).toBe('/home/test/.rcc/log/multi/ports');
    expect(spawnCalls[0]?.options.env.RCC_PORT_LOG_ROOT).toBe('/home/test/.rcc/log/multi/ports');
  });
});
