import os from 'node:os';
import path from 'node:path';

import { resolveRccSnapshotsDirNativeSync } from '../../src/modules/llmswitch/bridge/routing-integrations.js';

type EnvSnapshot = Record<
  'RCC_HOME' | 'ROUTECODEX_USER_DIR' | 'ROUTECODEX_HOME' | 'RCC_SNAPSHOT_DIR' | 'ROUTECODEX_SNAPSHOT_DIR',
  string | undefined
>;

function takeEnv(): EnvSnapshot {
  return {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME,
    RCC_SNAPSHOT_DIR: process.env.RCC_SNAPSHOT_DIR,
    ROUTECODEX_SNAPSHOT_DIR: process.env.ROUTECODEX_SNAPSHOT_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot) as Array<[keyof EnvSnapshot, string | undefined]>) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
}

function legacyResolve(homeDir?: string): string {
  const home = path.resolve(String(homeDir || process.env.HOME || os.homedir()).trim());
  const retired = path.join(home, '.routecodex', 'codex-samples');
  for (const key of ['RCC_SNAPSHOT_DIR', 'ROUTECODEX_SNAPSHOT_DIR'] as const) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) continue;
    const candidate = path.resolve(raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
    if (candidate === retired) {
      throw new Error(`[config] ${key} points to retired ~/.routecodex/codex-samples root; use ~/.rcc/codex-samples`);
    }
    return candidate;
  }
  const userDir = String(process.env.RCC_HOME || process.env.ROUTECODEX_USER_DIR || process.env.ROUTECODEX_HOME || '').trim();
  return path.join(userDir ? path.resolve(userDir) : path.join(home, '.rcc'), 'codex-samples');
}

describe('user data snapshots rust parity', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = takeEnv();
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    delete process.env.RCC_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;
  });

  afterEach(() => restoreEnv(envSnapshot));

  it('matches pre-wire snapshot env precedence', () => {
    process.env.RCC_SNAPSHOT_DIR = ' samples-a ';
    process.env.ROUTECODEX_SNAPSHOT_DIR = 'samples-b';
    expect(resolveRccSnapshotsDirNativeSync('/tmp/rcc-home')).toBe(legacyResolve('/tmp/rcc-home'));
  });

  it('matches pre-wire default snapshot path under rcc user dir', () => {
    process.env.RCC_HOME = '/tmp/rcc-home/.rcc';
    expect(resolveRccSnapshotsDirNativeSync('/tmp/rcc-home')).toBe(legacyResolve('/tmp/rcc-home'));
  });

  it('matches pre-wire retired snapshot rejection', () => {
    process.env.RCC_SNAPSHOT_DIR = '/tmp/rcc-home/.routecodex/codex-samples';
    expect(() => legacyResolve('/tmp/rcc-home')).toThrow('retired ~/.routecodex/codex-samples');
    expect(() => resolveRccSnapshotsDirNativeSync('/tmp/rcc-home')).toThrow('retired ~/.routecodex/codex-samples');
  });
});
