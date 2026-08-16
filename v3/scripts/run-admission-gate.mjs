#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const admissionRepo = resolve(v3Root, 'build-contracts', 'architecture-admission', 'repo');
const controlRoot = resolve(v3Root, 'build-control', 'admission-workspace');
const requested = process.argv[2];
const args = process.argv.slice(3);

function fail(message) {
  process.stderr.write(`[v3-admission-gate] FAIL ${message}\n`);
  process.exit(2);
}

if (!requested || requested.startsWith('/') || requested.includes('..')) {
  fail('gate path must be a V3-local relative path');
}

if (process.env.ROUTECODEX_V3_ADMISSION_WORKSPACE === '1') {
  const result = spawnSync(process.execPath, [requested, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 2);
}

if (!existsSync(resolve(admissionRepo, 'docs'))) {
  fail('tracked architecture admission repo view is missing');
}

mkdirSync(controlRoot, { recursive: true });
const workspace = mkdtempSync(resolve(controlRoot, 'run-'));
const tempRoot = resolve(workspace, 'tmp');

try {
  mkdirSync(tempRoot, { recursive: true });
  for (const name of ['.agents', '.github', 'docs']) {
    cpSync(resolve(admissionRepo, name), resolve(workspace, name), { recursive: true });
  }
  mkdirSync(resolve(workspace, 'v3'), { recursive: true });
  cpSync(
    resolve(admissionRepo, 'v3', 'config'),
    resolve(workspace, 'v3', 'config'),
    { recursive: true },
  );
  symlinkSync(resolve(workspace, 'v3', 'config'), resolve(workspace, 'config'), 'dir');
  cpSync(resolve(v3Root, 'scripts'), resolve(workspace, 'v3', 'scripts'), { recursive: true });
  symlinkSync(resolve(workspace, 'v3', 'scripts'), resolve(workspace, 'scripts'), 'dir');
  for (const name of [
    'architecture-wiki-lib.mjs',
    'mainline-call-map-lib.mjs',
    'wiki-html-lib.mjs',
  ]) {
    copyFileSync(
      resolve(admissionRepo, 'scripts', 'architecture', name),
      resolve(workspace, 'scripts', 'architecture', name),
    );
  }
  cpSync(resolve(v3Root, 'tests'), resolve(workspace, 'v3', 'tests'), { recursive: true });
  symlinkSync(resolve(workspace, 'v3', 'tests'), resolve(workspace, 'tests'), 'dir');
  cpSync(resolve(v3Root, 'build-contracts'), resolve(workspace, 'v3', 'build-contracts'), {
    recursive: true,
  });
  symlinkSync(
    resolve(workspace, 'v3', 'build-contracts'),
    resolve(workspace, 'build-contracts'),
    'dir',
  );
  for (const name of ['crates', 'fixtures']) {
    cpSync(resolve(v3Root, name), resolve(workspace, 'v3', name), { recursive: true });
  }
  cpSync(
    resolve(admissionRepo, 'v3', 'config'),
    resolve(workspace, 'v3', 'config'),
    { recursive: true },
  );
  for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
    copyFileSync(resolve(v3Root, name), resolve(workspace, 'v3', name));
  }
  for (const name of ['package.json', 'package-lock.json']) {
    copyFileSync(resolve(v3Root, name), resolve(workspace, 'v3', name));
  }
  symlinkSync(resolve(workspace, 'v3', 'crates'), resolve(workspace, 'crates'), 'dir');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json']) {
    copyFileSync(resolve(v3Root, name), resolve(workspace, name));
  }
  symlinkSync(resolve(v3Root, 'node_modules'), resolve(workspace, 'node_modules'), 'dir');

  const env = {
    ...process.env,
    ROUTECODEX_V3_ADMISSION_WORKSPACE: '1',
    ROUTECODEX_V3_SOURCE_ROOT: workspace,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  };
  const result = spawnSync(process.execPath, [requested, ...args], {
    cwd: workspace,
    env,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 2;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
