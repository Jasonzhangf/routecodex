import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquireInstallLock,
  isAutomaticDependencyInstallLifecycle,
  releaseInstallLock,
  resolveBuildVersion,
} from '../../scripts/install-cli.mjs';
import {
  commitVersion,
  releaseVersion,
  reserveVersion,
} from '../../scripts/version-ledger.mjs';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installScript = path.join(v3Root, 'scripts', 'install-cli.mjs');

function readLedger(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-install-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-install-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'routecodex-v3-build-version.json');
}

test('a dependency-install lifecycle never builds or publishes', () => {
  assert.equal(
    isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'install', npm_command: 'install' }),
    true,
  );
  assert.equal(
    isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'install', npm_command: 'ci' }),
    true,
  );
  assert.equal(
    isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'start', npm_command: 'install' }),
    false,
  );
});

test('the install lifecycle lock is exclusive and re-entrant when the wrapper holds it', (t) => {
  const home = tempHome(t);
  const lockDir = path.join(home, '.rcc', 'locks', 'install-lifecycle.lock');
  const env = { ...process.env, HOME: home, ROUTECODEX_INSTALL_LOCK_DIR: lockDir };

  const first = acquireInstallLockWithEnv(env);
  assert.equal(first.acquired, true);
  assert.ok(fs.existsSync(lockDir));

  // A second publisher is refused while the first holds the lock.
  assert.throws(
    () => acquireInstallLockWithEnv(env),
    (error) => /already in progress/.test(error.message),
  );

  // A nested install under the wrapper skips acquisition instead of deadlocking.
  const nested = acquireInstallLockWithEnv({ ...env, ROUTECODEX_INSTALL_LOCK_HELD: '1' });
  assert.equal(nested.acquired, false);

  releaseInstallLock(nested);
  assert.ok(fs.existsSync(lockDir), 'nested install must not release the wrapper lock');

  releaseInstallLock(first);
  assert.ok(!fs.existsSync(lockDir), 'lock must be released after the last holder');
});

// install-cli.mjs reads ROUTECODEX_INSTALL_LOCK_DIR/HELD from process.env at
// module import boundary only inside acquireInstallLock, so exercise through a
// child process to prove the real entry honors the shared lock.
test('a concurrent install process is refused while another install holds the lock', async (t) => {
  const home = tempHome(t);
  const lockDir = path.join(home, '.rcc', 'locks', 'install-lifecycle.lock');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir); // pre-held by another publisher
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [installScript],
    { cwd: v3Root, encoding: 'utf8', env: { ...process.env, HOME: home, ROUTECODEX_INSTALL_LOCK_DIR: lockDir } },
  );
  assert.notEqual(result.status, 0, 'install must fail fast while another install holds the lock');
  assert.match(result.stderr, /already in progress/);
});

test('resolveBuildVersion prefers the build-context reserved version over the ledger', (t) => {
  const home = tempHome(t);
  assert.equal(resolveBuildVersion({ ROUTECODEX_BUILD_VERSION: '0.90.9999' }), '0.90.9999');
});

// Regression for review r1 P1: install is a publication consumer, so it must
// never publish a live reservation. While a build holds version V but has not
// committed it, a concurrent install must publish the last committed version.
// If it published V and the reserving build then failed, V would be released
// and reused, producing two successful artifacts with the same version.
test('a live reservation is never published by a concurrent install', (t) => {
  const ledgerPath = tempLedger(t);
  const declaredVersion = '0.90.5000';

  // The reserving build holds V = 0.90.5001 but has not committed it yet.
  const reservation = reserveVersion({ ledgerPath, declaredVersion, buildId: 'reserving-build' });
  assert.equal(reservation.version, '0.90.5001');
  assert.equal(readLedger(ledgerPath).committed_version, '0.90.5000');

  // The concurrent install must resolve the committed version, never V.
  const installed = resolveBuildVersion({}, { ledgerPath, declaredVersion });
  assert.equal(installed, '0.90.5000');
  assert.notEqual(installed, reservation.version);
});

test('a failed reserving build cannot let a published version be reused', (t) => {
  const ledgerPath = tempLedger(t);
  const declaredVersion = '0.90.5000';

  const first = reserveVersion({ ledgerPath, declaredVersion, buildId: 'build-1' });
  // The concurrent install publishes the committed floor, not the reservation.
  assert.equal(resolveBuildVersion({}, { ledgerPath, declaredVersion }), '0.90.5000');

  // build-1 fails: the reservation is released, and a retry reuses its version.
  assert.equal(releaseVersion(first, { ledgerPath, declaredVersion }).released, true);
  const retry = reserveVersion({ ledgerPath, declaredVersion, buildId: 'build-2' });
  assert.equal(retry.version, first.version, 'a retry reuses the released version');
  assert.equal(resolveBuildVersion({}, { ledgerPath, declaredVersion }), '0.90.5000');

  // The retry commits; only now may that version be published, and the
  // install that already published 0.90.5000 never shared the reused version.
  assert.equal(commitVersion(retry, { ledgerPath, declaredVersion }).committed, first.version);
  assert.equal(resolveBuildVersion({}, { ledgerPath, declaredVersion }), first.version);

  const published = readLedger(ledgerPath).allocations.map((entry) => entry.version);
  assert.deepEqual(published, ['0.90.5001', '0.90.5001']);
});

test('a successful reserving build never shares its version with an install', (t) => {
  const ledgerPath = tempLedger(t);
  const declaredVersion = '0.90.5000';

  const reservation = reserveVersion({ ledgerPath, declaredVersion, buildId: 'build-1' });
  // While reserved, the concurrent install publishes the previous committed
  // version, so it cannot share the build's version.
  const duringBuild = resolveBuildVersion({}, { ledgerPath, declaredVersion });
  assert.equal(duringBuild, '0.90.5000');
  assert.notEqual(duringBuild, reservation.version);

  assert.equal(commitVersion(reservation, { ledgerPath, declaredVersion }).committed, '0.90.5001');
  // After the build commits, the version is a finished allocation and may be
  // published by a later install.
  assert.equal(resolveBuildVersion({}, { ledgerPath, declaredVersion }), '0.90.5001');
});

const LOCK_ENV_KEYS = ['ROUTECODEX_INSTALL_LOCK_DIR', 'ROUTECODEX_INSTALL_LOCK_HELD', 'HOME'];

function acquireInstallLockWithEnv(env) {
  const previous = Object.fromEntries(
    LOCK_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of LOCK_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (LOCK_ENV_KEYS.includes(key) && value !== undefined) process.env[key] = value;
    }
    return acquireInstallLock();
  } finally {
    for (const key of LOCK_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
