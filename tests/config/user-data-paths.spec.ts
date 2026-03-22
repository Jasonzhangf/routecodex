import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ensureRccUserDirEnvironment,
  resolveLegacyRouteCodexUserDir,
  resolveRccConfigFile,
  resolveRccProviderDir,
  resolveRccSnapshotsDirFromEnv,
  resolveRccSubdir,
  resolveRccUserDir,
  resolveRccUserDirForRead
} from '../../src/config/user-data-paths.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('user-data-paths', () => {
  const originalEnv = {
    RCC_HOME: process.env.RCC_HOME,
    ROUTECODEX_USER_DIR: process.env.ROUTECODEX_USER_DIR,
    ROUTECODEX_HOME: process.env.ROUTECODEX_HOME,
    RCC_SNAPSHOT_DIR: process.env.RCC_SNAPSHOT_DIR,
    ROUTECODEX_SNAPSHOT_DIR: process.env.ROUTECODEX_SNAPSHOT_DIR
  };

  afterEach(() => {
    if (typeof originalEnv.RCC_HOME === 'string') {
      process.env.RCC_HOME = originalEnv.RCC_HOME;
    } else {
      delete process.env.RCC_HOME;
    }
    if (typeof originalEnv.ROUTECODEX_USER_DIR === 'string') {
      process.env.ROUTECODEX_USER_DIR = originalEnv.ROUTECODEX_USER_DIR;
    } else {
      delete process.env.ROUTECODEX_USER_DIR;
    }
    if (typeof originalEnv.ROUTECODEX_HOME === 'string') {
      process.env.ROUTECODEX_HOME = originalEnv.ROUTECODEX_HOME;
    } else {
      delete process.env.ROUTECODEX_HOME;
    }
    if (typeof originalEnv.RCC_SNAPSHOT_DIR === 'string') {
      process.env.RCC_SNAPSHOT_DIR = originalEnv.RCC_SNAPSHOT_DIR;
    } else {
      delete process.env.RCC_SNAPSHOT_DIR;
    }
    if (typeof originalEnv.ROUTECODEX_SNAPSHOT_DIR === 'string') {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalEnv.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    }
  });

  it('defaults to ~/.rcc for the primary user dir', async () => {
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    const home = await createTempDir('rcc-home-');
    expect(resolveRccUserDir(home)).toBe(path.join(home, '.rcc'));
    expect(resolveLegacyRouteCodexUserDir(home)).toBe(path.join(home, '.routecodex'));
  });

  it('keeps read helpers pinned to the primary ~/.rcc root', async () => {
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;

    const home = await createTempDir('rcc-legacy-read-');
    const legacyRoot = path.join(home, '.routecodex');
    const legacyConfig = path.join(legacyRoot, 'config.json');
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(legacyConfig, '{}\n', 'utf8');

    expect(resolveRccUserDirForRead(home)).toBe(path.join(home, '.rcc'));
  });

  it('publishes the resolved ~/.rcc path into process env for downstream modules', async () => {
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;
    delete process.env.RCC_SNAPSHOT_DIR;
    delete process.env.ROUTECODEX_SNAPSHOT_DIR;

    const home = await createTempDir('rcc-env-');
    const expected = path.join(home, '.rcc');
    const resolved = ensureRccUserDirEnvironment(home);
    expect(resolved).toBe(expected);
    expect(process.env.RCC_HOME).toBe(expected);
    expect(process.env.ROUTECODEX_USER_DIR).toBe(expected);
    expect(process.env.ROUTECODEX_HOME).toBe(expected);
    expect(process.env.RCC_SNAPSHOT_DIR).toBe(path.join(expected, 'codex-samples'));
    expect(process.env.ROUTECODEX_SNAPSHOT_DIR).toBe(path.join(expected, 'codex-samples'));
    expect(resolveRccSnapshotsDirFromEnv(home)).toBe(path.join(expected, 'codex-samples'));
  });

  it('overrides legacy snapshot env values to the primary ~/.rcc snapshot root', async () => {
    const home = await createTempDir('rcc-snapshot-env-');
    process.env.RCC_SNAPSHOT_DIR = path.join(home, '.routecodex', 'codex-samples');
    process.env.ROUTECODEX_SNAPSHOT_DIR = path.join(home, '.routecodex', 'codex-samples');

    ensureRccUserDirEnvironment(home);

    const expectedSnapshotsDir = path.join(home, '.rcc', 'codex-samples');
    expect(process.env.RCC_SNAPSHOT_DIR).toBe(expectedSnapshotsDir);
    expect(process.env.ROUTECODEX_SNAPSHOT_DIR).toBe(expectedSnapshotsDir);
    expect(resolveRccSnapshotsDirFromEnv(home)).toBe(expectedSnapshotsDir);
  });

  it('resolves named subdirectories and config/provider helpers from the same layout registry', async () => {
    delete process.env.RCC_HOME;
    delete process.env.ROUTECODEX_USER_DIR;
    delete process.env.ROUTECODEX_HOME;

    const home = await createTempDir('rcc-layout-');
    expect(resolveRccSubdir('provider', home)).toBe(path.join(home, '.rcc', 'provider'));
    expect(resolveRccProviderDir(home)).toBe(path.join(home, '.rcc', 'provider'));
    expect(resolveRccConfigFile(home)).toBe(path.join(home, '.rcc', 'config.json'));
  });
});
