import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isAutomaticDependencyInstallLifecycle } from '../../scripts/install-cli.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootExecutableScript = path.join(repoRoot, 'scripts', 'ensure-cli-executable.mjs');
const rootShimScript = path.join(repoRoot, 'scripts', 'ensure-cli-command-shim.mjs');
const v3InstallScript = path.join(repoRoot, 'v3', 'scripts', 'install-cli.mjs');

function makeSentinelHome(base, { withAliases = true } = {}) {
  const home = path.join(base, 'home');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const rccv3 = path.join(bin, 'rccv3');
  fs.writeFileSync(rccv3, 'SENTINEL-RCCV3');
  fs.chmodSync(rccv3, 0o600);
  if (withAliases) {
    fs.symlinkSync('rccv3', path.join(bin, 'rcc'));
    fs.symlinkSync('rccv3', path.join(bin, 'routecodex'));
  }
  return { home, bin };
}

function snapshotBin(bin) {
  const entries = fs.readdirSync(bin).sort().map((name) => {
    const filePath = path.join(bin, name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      return `${name}:symlink:${fs.readlinkSync(filePath)}`;
    }
    const mode = (stat.mode & 0o777).toString(8);
    return `${name}:file:${mode}:${fs.readFileSync(filePath, 'utf8')}`;
  });
  return entries.join('|');
}

function runNpm(args, cwd, env) {
  return spawnSync(npmBin, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('root dependency-install lifecycle leaves installed CLI commands untouched', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-root-boundary-'));
  const { home, bin } = makeSentinelHome(base);
  const fixture = path.join(base, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const postinstall = [
    `node ${JSON.stringify(rootExecutableScript)}`,
    `node ${JSON.stringify(rootShimScript)}`,
  ].join(' && ');
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({
      name: 'boundary-root-fixture',
      version: '1.0.0',
      private: true,
      scripts: { postinstall },
    }, null, 2),
  );

  const before = snapshotBin(bin);
  const result = runNpm(
    ['install', '--no-audit', '--no-fund', '--no-package-lock'],
    fixture,
    { HOME: home, npm_config_cache: path.join(base, 'cache'), npm_config_update_notifier: false },
  );

  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(snapshotBin(bin), before);
    assert.match(result.stdout, /\[cli-executable\] skip/);
    assert.match(result.stdout, /\[cli-shim\] skip/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('v3 dependency-install lifecycle leaves installed CLI commands untouched', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-v3-boundary-'));
  const { home, bin } = makeSentinelHome(base);
  const fixture = path.join(base, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({
      name: 'boundary-v3-fixture',
      version: '1.0.0',
      private: true,
      scripts: { install: `node ${JSON.stringify(v3InstallScript)}` },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(fixture, 'package-lock.json'),
    JSON.stringify({
      name: 'boundary-v3-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'boundary-v3-fixture',
          version: '1.0.0',
          hasInstallScript: true,
        },
      },
    }, null, 2),
  );

  const before = snapshotBin(bin);
  const result = runNpm(
    ['ci', '--no-audit', '--no-fund'],
    fixture,
    { HOME: home, npm_config_cache: path.join(base, 'cache'), npm_config_update_notifier: false },
  );

  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(snapshotBin(bin), before);
    assert.match(result.stdout, /\[install-cli\] skip/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('explicit fix:cli-shim still publishes command aliases', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-explicit-shim-'));
  const { home, bin } = makeSentinelHome(base, { withAliases: false });
  const fixture = path.join(base, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({
      name: 'boundary-explicit-shim-fixture',
      version: '1.0.0',
      private: true,
      scripts: { 'fix:cli-shim': `node ${JSON.stringify(rootShimScript)}` },
    }, null, 2),
  );

  const result = runNpm(
    ['run', 'fix:cli-shim'],
    fixture,
    { HOME: home, npm_config_cache: path.join(base, 'cache'), npm_config_update_notifier: false },
  );

  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.lstatSync(path.join(bin, 'rcc')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(bin, 'rcc')), 'rccv3');
    assert.equal(fs.lstatSync(path.join(bin, 'routecodex')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(bin, 'routecodex')), 'rccv3');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('automatic dependency-install lifecycle is distinguished from explicit install', () => {
  assert.equal(isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'install', npm_command: 'ci' }), true);
  assert.equal(isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'install', npm_command: 'install' }), true);
  assert.equal(isAutomaticDependencyInstallLifecycle({ npm_lifecycle_event: 'install', npm_command: 'run-script' }), false);
  assert.equal(isAutomaticDependencyInstallLifecycle({}), false);
});
