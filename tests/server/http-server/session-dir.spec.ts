import { jest } from '@jest/globals';
import path from 'node:path';
import os from 'node:os';
import { ensureServerScopedSessionDir, resolveServerScopedSessionDir } from '../../../src/server/runtime/http-server/session-dir.js';

describe('server-scoped session dir', () => {
  const ORIGINAL = process.env.ROUTECODEX_SESSION_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = ORIGINAL;
    }
  });

  test('resolves default session dir under ~/.routecodex/sessions/<serverId>', () => {
    const serverId = '127.0.0.1:3001';
    const resolved = resolveServerScopedSessionDir(serverId);
    expect(resolved).toBeTruthy();
    expect(resolved).toBe(path.join(os.homedir(), '.routecodex', 'sessions', '127.0.0.1_3001'));
  });

  test('does not override preconfigured ROUTECODEX_SESSION_DIR', () => {
    process.env.ROUTECODEX_SESSION_DIR = '/tmp/custom-sessions';
    const ensured = ensureServerScopedSessionDir('127.0.0.1:3001');
    expect(ensured).toBe('/tmp/custom-sessions');
    expect(process.env.ROUTECODEX_SESSION_DIR).toBe('/tmp/custom-sessions');
  });

  test('overrides auto-scoped ~/.routecodex/sessions/<serverId> when serverId changes', () => {
    process.env.ROUTECODEX_SESSION_DIR = path.join(os.homedir(), '.routecodex', 'sessions', '127.0.0.1_3001');
    const ensured = ensureServerScopedSessionDir('0.0.0.0:5520');
    expect(ensured).toBe(path.join(os.homedir(), '.routecodex', 'sessions', '0.0.0.0_5520'));
    expect(process.env.ROUTECODEX_SESSION_DIR).toBe(ensured);
  });

  test('sets ROUTECODEX_SESSION_DIR when missing', () => {
    delete process.env.ROUTECODEX_SESSION_DIR;
    const ensured = ensureServerScopedSessionDir('127.0.0.1:3001');
    expect(ensured).toBe(path.join(os.homedir(), '.routecodex', 'sessions', '127.0.0.1_3001'));
    expect(process.env.ROUTECODEX_SESSION_DIR).toBe(ensured);
  });

  test('returns null when serverId is empty/invalid', () => {
    expect(resolveServerScopedSessionDir('')).toBeNull();
    expect(resolveServerScopedSessionDir('   ')).toBeNull();
    expect(resolveServerScopedSessionDir('::::')).toBeNull();
  });

  test('returns null when os.homedir is empty', () => {
    const spy = jest.spyOn(os, 'homedir').mockReturnValueOnce('');
    try {
      expect(resolveServerScopedSessionDir('127.0.0.1:3001')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
