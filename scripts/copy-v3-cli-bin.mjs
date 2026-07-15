#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'v3', 'Cargo.toml');
const sourceBin = path.join(root, 'v3', 'target', 'debug', process.platform === 'win32' ? 'routecodex-v3.exe' : 'routecodex-v3');
const targetBin = path.join(root, 'dist', 'bin', process.platform === 'win32' ? 'routecodex-v3.exe' : 'routecodex-v3');

function fail(message) {
  console.error(`[copy-v3-cli-bin] ${message}`);
  process.exit(2);
}

if (!fs.existsSync(manifestPath)) {
  fail(`missing V3 manifest: ${manifestPath}`);
}

const env = { ...process.env };
if (!Object.prototype.hasOwnProperty.call(env, 'CARGO_NET_OFFLINE')) {
  env.CARGO_NET_OFFLINE = 'true';
}

const result = spawnSync('cargo', [
  'build',
  '--manifest-path',
  manifestPath,
  '-p',
  'routecodex-v3-cli',
], { cwd: root, env, stdio: 'inherit' });

if ((result.status ?? 0) !== 0) {
  fail('cargo build failed for routecodex-v3-cli');
}
if (!fs.existsSync(sourceBin)) {
  fail(`built V3 CLI binary not found: ${sourceBin}`);
}

fs.mkdirSync(path.dirname(targetBin), { recursive: true });
fs.copyFileSync(sourceBin, targetBin);
if (process.platform !== 'win32') {
  fs.chmodSync(targetBin, 0o755);
}
console.log(`[copy-v3-cli-bin] copied ${path.relative(root, sourceBin)} -> ${path.relative(root, targetBin)}`);
