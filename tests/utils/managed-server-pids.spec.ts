import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  isTrustedRouteCodexCommand,
  listManagedServerPidsByPort,
  listManagedServerZombieChildrenByPort,
  listZombieChildrenByParentPids,
  resolveManagedServerPidFiles
} from '../../src/utils/managed-server-pids.js';

describe('managed server pid discovery', () => {
  it('resolveManagedServerPidFiles returns only port-scoped pid file', () => {
    const files = resolveManagedServerPidFiles(5520, '/tmp/rc-home');
    expect(files).toEqual(['/tmp/rc-home/server-5520.pid']);
  });

  it('isTrustedRouteCodexCommand accepts routecodex dist entry', () => {
    expect(isTrustedRouteCodexCommand('/opt/homebrew/bin/node /Users/me/routecodex/dist/index.js config/modules.json')).toBe(true);
  });

  it('isTrustedRouteCodexCommand rejects unrelated commands', () => {
    expect(isTrustedRouteCodexCommand('/usr/bin/node /tmp/random-script.js')).toBe(false);
  });

  it('listManagedServerPidsByPort returns alive trusted pid', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-pids-list-'));
    fs.writeFileSync(path.join(home, 'server-5520.pid'), String(process.pid), 'utf8');

    const pids = listManagedServerPidsByPort(5520, {
      routeCodexHomeDir: home,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid === process.pid) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string) => {
        if (cmd === 'ps') {
          return {
            stdout: '/opt/homebrew/bin/node /Users/fanzhang/Documents/github/routecodex/dist/index.js config/modules.json ROUTECODEX_PORT=5520 RCC_PORT=5520',
            status: 0,
            error: undefined
          } as any;
        }
        throw new Error('unexpected command');
      }) as any
    });

    expect(pids).toEqual([process.pid]);
  });

  it('listManagedServerPidsByPort skips trusted pid with mismatched ROUTECODEX_PORT', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-pids-port-mismatch-'));
    fs.writeFileSync(path.join(home, 'server-5520.pid'), String(process.pid), 'utf8');

    const pids = listManagedServerPidsByPort(5520, {
      routeCodexHomeDir: home,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid === process.pid) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string) => {
        if (cmd === 'ps') {
          return {
            stdout: '/opt/homebrew/bin/node /Users/fanzhang/Documents/github/routecodex/dist/index.js config/modules.json ROUTECODEX_PORT=5522 RCC_PORT=5522',
            status: 0,
            error: undefined
          } as any;
        }
        throw new Error('unexpected command');
      }) as any
    });

    expect(pids).toEqual([]);
  });

  it('listZombieChildrenByParentPids filters zombie processes by parent pid', () => {
    const zombies = listZombieChildrenByParentPids([200, 999], {
      spawnSyncImpl: ((cmd: string) => {
        if (cmd !== 'ps') {
          throw new Error('unexpected command');
        }
        return {
          stdout: [
            '101 200 Z+ /bin/zsh <defunct>',
            '102 200 S+ /bin/zsh',
            '103 300 Z+ /bin/zsh <defunct>',
            '104 999 Z routecodex-child <defunct>'
          ].join('\n'),
          status: 0,
          error: undefined
        } as any;
      }) as any
    });

    expect(zombies.map((item) => item.pid)).toEqual([101, 104]);
    expect(zombies.map((item) => item.ppid)).toEqual([200, 999]);
  });

  it('listManagedServerZombieChildrenByPort resolves managed parent before zombie filter', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-managed-zombie-'));
    fs.writeFileSync(path.join(home, 'server-5520.pid'), '777', 'utf8');

    const zombies = listManagedServerZombieChildrenByPort(5520, {
      routeCodexHomeDir: home,
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === 777 && signal === 0) {
          return true as any;
        }
        throw new Error('unexpected processKill call');
      }) as any,
      spawnSyncImpl: ((cmd: string, args: string[]) => {
        if (cmd !== 'ps') {
          throw new Error('unexpected command');
        }
        const joined = Array.isArray(args) ? args.join(' ') : '';
        if (joined.includes('-p 777')) {
          return {
            stdout: '/opt/homebrew/bin/node /Users/fanzhang/Documents/github/routecodex/dist/index.js config/modules.json ROUTECODEX_PORT=5520 RCC_PORT=5520',
            status: 0,
            error: undefined
          } as any;
        }
        return {
          stdout: [
            '201 777 Z+ child-a <defunct>',
            '202 778 Z+ child-b <defunct>'
          ].join('\n'),
          status: 0,
          error: undefined
        } as any;
      }) as any
    });

    expect(zombies.map((item) => item.pid)).toEqual([201]);
    expect(zombies[0]?.ppid).toBe(777);
  });
});
