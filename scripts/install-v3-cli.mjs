#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'v3', 'Cargo.toml');
const packageJsonPath = path.join(repoRoot, 'package.json');
const binaryName = process.platform === 'win32' ? 'rccv3.exe' : 'rccv3';
const repoBin = path.join(repoRoot, 'dist', 'bin', binaryName);
const RCC_HOME_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'];

function fail(message) {
  console.error(`[install-v3-cli] ${message}`);
  process.exit(2);
}

function resolveHomeDir() {
  return path.resolve(String(process.env.HOME || '').trim() || os.homedir());
}

function expandUserPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  if (normalized === '~') {
    return resolveHomeDir();
  }
  if (normalized.startsWith('~/')) {
    return path.join(resolveHomeDir(), normalized.slice(2));
  }
  return path.resolve(normalized);
}

function buildV3Cli() {
  if (!fs.existsSync(manifestPath)) {
    fail(`missing V3 manifest: ${manifestPath}`);
  }
  const env = { ...process.env };
  if (!Object.prototype.hasOwnProperty.call(env, 'RUSTUP_TOOLCHAIN')) {
    env.RUSTUP_TOOLCHAIN = 'stable';
  }
  if (!Object.prototype.hasOwnProperty.call(env, 'CARGO_NET_OFFLINE')) {
    env.CARGO_NET_OFFLINE = 'true';
  }
  const cargoTargetDir = env.CARGO_TARGET_DIR
    ? path.resolve(env.CARGO_TARGET_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-install-target-'));
  env.CARGO_TARGET_DIR = cargoTargetDir;
  const result = spawnSync('cargo', [
    'build',
    '--manifest-path',
    manifestPath,
    '-p',
    'routecodex-v3-cli',
  ], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  if ((result.status ?? 0) !== 0) {
    fail('cargo build failed for routecodex-v3-cli');
  }
  const sourceBin = path.join(cargoTargetDir, 'debug', binaryName);
  if (!fs.existsSync(sourceBin)) {
    fail(`built V3 CLI binary not found: ${sourceBin}`);
  }
  return sourceBin;
}

function copyExecutableAtomic(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    fail(`source binary missing: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(sourcePath, tempPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(tempPath, 0o755);
  }
  fs.renameSync(tempPath, targetPath);
}

function copyPackageJsonAtomic(targetPath) {
  if (!fs.existsSync(packageJsonPath)) {
    fail(`source package.json missing: ${packageJsonPath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(packageJsonPath, tempPath);
  fs.renameSync(tempPath, targetPath);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function splitPathList(value) {
  return String(value || '')
    .split(path.delimiter)
    .map(expandUserPath)
    .filter(Boolean);
}

function readActiveRccHomes() {
  const result = spawnSync('ps', ['-axo', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((result.status ?? 0) !== 0) {
    return [];
  }
  const homes = [];
  for (const line of String(result.stdout || '').split(/\r?\n/u)) {
    const match = line.match(/(\S+?\.rcc)\/install\/(?:current|releases\/[^/\s]+)\/dist\/bin\/rccv3(?:\s|$)/u);
    if (match?.[1]) {
      homes.push(path.resolve(match[1]));
    }
  }
  return homes;
}

function defaultCandidateHomes() {
  const homes = [];
  for (const key of RCC_HOME_ENV_KEYS) {
    const expanded = expandUserPath(process.env[key]);
    if (expanded) {
      homes.push(expanded);
    }
  }
  homes.push(path.join(resolveHomeDir(), '.rcc'));
  const volumeHome = '/Volumes/extension/.rcc';
  if (fs.existsSync(volumeHome)) {
    homes.push(volumeHome);
  }
  homes.push(...readActiveRccHomes());
  return homes;
}

function uniqueExistingHomes(homes, explicit) {
  const seen = new Set();
  const unique = [];
  for (const home of homes) {
    const normalized = path.resolve(home);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const currentBin = path.join(normalized, 'install', 'current', 'dist', 'bin', binaryName);
    if (!fs.existsSync(currentBin)) {
      if (explicit) {
        fail(`V3 install target missing current rccv3: ${currentBin}`);
      }
      continue;
    }
    unique.push({ home: normalized, currentBin });
  }
  return unique;
}

function resolveInstallTargets() {
  const explicitHomes = splitPathList(process.env.ROUTECODEX_V3_INSTALL_HOMES)
    .concat(splitPathList(process.env.RCC_V3_INSTALL_HOMES));
  const explicit = explicitHomes.length > 0;
  const homes = uniqueExistingHomes(explicit ? explicitHomes : defaultCandidateHomes(), explicit);
  if (homes.length === 0) {
    fail(
      'no V3 install/current target found; set ROUTECODEX_V3_INSTALL_HOMES to one or more .rcc homes',
    );
  }
  return homes;
}

function main() {
  const sourceBin = buildV3Cli();
  copyExecutableAtomic(sourceBin, repoBin);
  const expectedHash = sha256(repoBin);
  console.log(`[install-v3-cli] installed repo ${path.relative(repoRoot, repoBin)} sha256=${expectedHash}`);

  const targets = resolveInstallTargets();
  for (const target of targets) {
    copyExecutableAtomic(repoBin, target.currentBin);
    const targetPackageJson = path.join(target.home, 'install', 'current', 'package.json');
    copyPackageJsonAtomic(targetPackageJson);
    const actualHash = sha256(target.currentBin);
    if (actualHash !== expectedHash) {
      fail(`hash mismatch after installing ${target.currentBin}`);
    }
    console.log(`[install-v3-cli] installed ${target.currentBin} sha256=${actualHash}`);
  }
  console.log(`[install-v3-cli] ok: installed V3 CLI only; skipped TS build, WebUI build, and release snapshot`);
}

try {
  main();
} catch (error) {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  fail(reason);
}
