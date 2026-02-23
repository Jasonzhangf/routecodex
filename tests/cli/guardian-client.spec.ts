import { describe, expect, it } from '@jest/globals';

import {
  ensureGuardianDaemon,
  registerGuardianProcess,
  reportGuardianLifecycleEvent,
  stopGuardianDaemon
} from '../../src/cli/guardian/client.js';
import { resolveGuardianPaths } from '../../src/cli/guardian/paths.js';

function createMemFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  let fd = 100;
  const openFds = new Set<number>();

  const impl = {
    existsSync: (target: string) => files.has(String(target)),
    readFileSync: (target: string) => {
      const key = String(target);
      if (!files.has(key)) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return String(files.get(key));
    },
    writeFileSync: (target: string, value: string) => {
      files.set(String(target), String(value));
    },
    mkdirSync: () => {},
    openSync: (target: string, flag: string) => {
      const key = String(target);
      if (flag === 'wx' && files.has(key)) {
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      if (flag === 'wx') {
        files.set(key, 'lock');
      }
      fd += 1;
      openFds.add(fd);
      return fd;
    },
    closeSync: (handle: number) => {
      openFds.delete(handle);
    },
    unlinkSync: (target: string) => {
      files.delete(String(target));
    }
  };

  return { files, impl };
}

describe('guardian client', () => {
  it('returns existing healthy daemon without spawning', async () => {
    const homeDir = '/tmp/home-a';
    const paths = resolveGuardianPaths(homeDir);
    const state = {
      pid: 123,
      port: 5511,
      token: 'token-a',
      stopToken: 'stop-a',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const fsState = createMemFs({
      [paths.stateFile]: JSON.stringify(state)
    });

    let spawnCalled = 0;
    const ensured = await ensureGuardianDaemon({
      homeDir,
      nodeBin: 'node',
      cliEntryPath: '/tmp/cli.js',
      env: {},
      fsImpl: fsState.impl as any,
      spawn: () => {
        spawnCalled += 1;
        return { unref: () => {} } as any;
      },
      sleep: async () => {},
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (!url.endsWith('/health')) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        if ((init?.headers as Record<string, string> | undefined)?.['x-rcc-guardian-token'] !== state.token) {
          return { ok: false, status: 401, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }) as any
    });

    expect(spawnCalled).toBe(0);
    expect(ensured.port).toBe(state.port);
  });

  it('spawns daemon when no state exists and waits until healthy', async () => {
    const homeDir = '/tmp/home-b';
    const paths = resolveGuardianPaths(homeDir);
    const fsState = createMemFs();
    let spawnCalled = 0;

    const ensured = await ensureGuardianDaemon({
      homeDir,
      nodeBin: 'node',
      cliEntryPath: '/tmp/cli.js',
      env: {},
      fsImpl: fsState.impl as any,
      spawn: () => {
        spawnCalled += 1;
        const state = {
          pid: 456,
          port: 5599,
          token: 'token-b',
          stopToken: 'stop-b',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        fsState.files.set(paths.stateFile, JSON.stringify(state));
        return { unref: () => {} } as any;
      },
      sleep: async () => {},
      fetchImpl: (async (url: string) => {
        if (!url.endsWith('/health')) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }) as any
    });

    expect(spawnCalled).toBe(1);
    expect(ensured.pid).toBe(456);
    expect(ensured.port).toBe(5599);
  });

  it('supports register/lifecycle/stop with state tokens', async () => {
    const homeDir = '/tmp/home-c';
    const paths = resolveGuardianPaths(homeDir);
    const state = {
      pid: 789,
      port: 5620,
      token: 'token-c',
      stopToken: 'stop-c',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const fsState = createMemFs({
      [paths.stateFile]: JSON.stringify(state)
    });

    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = String(init?.method || 'GET');
      calls.push({ url, method });
      if (url.endsWith('/register')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      if (url.endsWith('/lifecycle')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, allowed: true }) } as any;
      }
      if (url.endsWith('/stop')) {
        fsState.files.delete(paths.stateFile);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) } as any;
    }) as any;

    await registerGuardianProcess({
      homeDir,
      fetchImpl,
      fsImpl: fsState.impl as any,
      registration: {
        source: 'codex',
        pid: 100,
        ppid: 10,
        port: 5520
      }
    });

    const lifecycleOk = await reportGuardianLifecycleEvent({
      homeDir,
      fetchImpl,
      fsImpl: fsState.impl as any,
      event: {
        action: 'exit_request',
        source: 'cli.launcher.codex',
        actorPid: 100
      }
    });

    const stopped = await stopGuardianDaemon({
      homeDir,
      fetchImpl,
      fsImpl: fsState.impl as any,
      sleep: async () => {}
    });

    expect(lifecycleOk).toBe(true);
    expect(stopped.requested).toBe(true);
    expect(stopped.stopped).toBe(true);
    expect(calls.map((item) => `${item.method} ${item.url.split('/').pop()}`)).toEqual([
      'POST register',
      'POST lifecycle',
      'POST stop'
    ]);
  });
});
