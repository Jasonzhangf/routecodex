#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'v3', 'Cargo.toml');
const packageJsonPath = path.join(repoRoot, 'package.json');
const buildInfoScript = path.join(repoRoot, 'scripts', 'gen-build-info.mjs');
const routeClassifierFileSizeGate = path.join(
  repoRoot,
  'scripts',
  'architecture',
  'verify-route-classifier-core-file-size.mjs',
);
const v3ArchitectureCiGate = path.join(
  repoRoot,
  'scripts',
  'architecture',
  'verify-v3-architecture-ci.mjs',
);
const binaryName = process.platform === 'win32' ? 'rccv3.exe' : 'rccv3';
const repoBin = path.join(repoRoot, 'dist', 'bin', binaryName);
const RCC_HOME_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'];

export function buildV3CargoEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  if (!Object.prototype.hasOwnProperty.call(env, 'RUSTUP_TOOLCHAIN')) {
    env.RUSTUP_TOOLCHAIN = 'stable';
  }
  if (!Object.prototype.hasOwnProperty.call(env, 'CARGO_NET_OFFLINE')) {
    env.CARGO_NET_OFFLINE = 'true';
  }
  const ownsCargoTargetDir = !env.CARGO_TARGET_DIR;
  const cargoTargetDir = ownsCargoTargetDir
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-install-target-'))
    : path.resolve(env.CARGO_TARGET_DIR);
  env.CARGO_TARGET_DIR = cargoTargetDir;
  return { env, cargoTargetDir, ownsCargoTargetDir };
}

function fail(message) {
  throw new Error(message);
}

class InstallInterruptedError extends Error {
  constructor(signal) {
    super(`V3 install interrupted by ${signal}`);
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

export function runInterruptibleCommand(command, args, options, build, label) {
  return new Promise((resolve, reject) => {
    let spawnFailed = false;
    const child = spawn(command, args, options);
    build.activeChildRootPid = child.pid;
    build.activeChild = child;
    child.once('error', (error) => {
      spawnFailed = true;
      build.activeChild = null;
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once('close', async (status, signal) => {
      if (spawnFailed) {
        return;
      }
      await waitForOwnedProcessTreeExit(build.interruptedPids);
      build.activeChild = null;
      build.activeChildRootPid = null;
      if (build.interruptedSignal) {
        reject(new InstallInterruptedError(build.interruptedSignal));
      } else if (signal) {
        reject(new Error(`${label} terminated by signal ${signal}`));
      } else if (status !== 0) {
        reject(new Error(`${label} failed with status ${status}`));
      } else {
        resolve();
      }
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function collectOwnedProcessTreePids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || process.platform === 'win32') {
    return Number.isInteger(rootPid) && rootPid > 0 ? [rootPid] : [];
  }
  const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error) {
    return [rootPid];
  }
  const childrenByParent = new Map();
  for (const line of result.stdout.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText, 10);
    const ppid = Number.parseInt(ppidText, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  const ordered = [];
  const visit = (pid) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
    ordered.push(pid);
  };
  visit(rootPid);
  return ordered;
}

function signalOwnedProcessTree(rootPid, signal) {
  const pids = collectOwnedProcessTreePids(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }
  return pids;
}

async function waitForOwnedProcessTreeExit(pids) {
  for (const pid of pids ?? []) {
    while (processExists(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitForOwnedTargetSafeToRemove(build) {
  await waitForOwnedProcessTreeExit(build.interruptedPids);
  if (build.activeChildRootPid) {
    await waitForOwnedProcessTreeExit([build.activeChildRootPid]);
  }
}

async function cleanupOwnedCargoTargetWhenSafe(build) {
  await waitForOwnedTargetSafeToRemove(build);
  cleanupOwnedCargoTarget(build.cargoTargetDir, build.ownsCargoTargetDir);
}

async function waitForInterruptCleanup(build) {
  while (build.interruptedSignal && build.activeChild) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

async function buildV3Cli(build) {
  const { env, cargoTargetDir } = build;
  if (!fs.existsSync(manifestPath)) {
    fail(`missing V3 manifest: ${manifestPath}`);
  }
  await runInterruptibleCommand(process.execPath, [v3ArchitectureCiGate], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  }, build, 'V3 architecture CI gate');
  await runInterruptibleCommand(process.execPath, [routeClassifierFileSizeGate], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  }, build, 'route classifier file-size gate');
  await runInterruptibleCommand(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'test:route-classifier-semantics'],
    {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    },
    build,
    'route classifier semantic gate',
  );
  await runInterruptibleCommand(process.execPath, [buildInfoScript], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  }, build, 'build-info/version generation');
  await runInterruptibleCommand('cargo', [
    'build',
    '--manifest-path',
    manifestPath,
    '-p',
    'routecodex-v3-cli',
  ], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  }, build, 'cargo build for routecodex-v3-cli');
  const sourceBin = path.join(cargoTargetDir, 'debug', binaryName);
  if (!fs.existsSync(sourceBin)) {
    fail(`built V3 CLI binary not found: ${sourceBin}`);
  }
  return sourceBin;
}

export function cleanupOwnedCargoTarget(cargoTargetDir, ownsCargoTargetDir) {
  if (!ownsCargoTargetDir) {
    return;
  }
  fs.rmSync(cargoTargetDir, { recursive: true, force: true });
}

export async function withOwnedV3CargoTarget(run, sourceEnv = process.env) {
  const build = buildV3CargoEnv(sourceEnv);
  build.activeChild = null;
  build.activeChildRootPid = null;
  build.interruptedSignal = null;
  build.interruptedPids = [];
  const handleSignal = (signal) => {
    build.interruptedSignal ??= signal;
    if (Number.isInteger(build.activeChildRootPid)) {
      build.interruptedPids = signalOwnedProcessTree(build.activeChildRootPid, signal);
    } else if (build.activeChild && !build.activeChild.killed) {
      build.activeChild.kill(signal);
    }
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    const result = await run(build);
    if (build.interruptedSignal) {
      await waitForInterruptCleanup(build);
      throw new InstallInterruptedError(build.interruptedSignal);
    }
    return result;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanupOwnedCargoTargetWhenSafe(build);
  }
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

function uniqueInstallHomes(homes) {
  const seen = new Set();
  const unique = [];
  for (const home of homes) {
    const normalized = path.resolve(home);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const currentBin = path.join(normalized, 'install', 'current', 'dist', 'bin', binaryName);
    unique.push({ home: normalized, currentBin });
  }
  return unique;
}

function resolveInstallTargets() {
  const explicitHomes = splitPathList(process.env.ROUTECODEX_V3_INSTALL_HOMES)
    .concat(splitPathList(process.env.RCC_V3_INSTALL_HOMES));
  const explicit = explicitHomes.length > 0;
  const homes = uniqueInstallHomes(explicit ? explicitHomes : defaultCandidateHomes());
  if (homes.length === 0) {
    fail(
      'no V3 install target resolved; set ROUTECODEX_V3_INSTALL_HOMES to one or more .rcc homes',
    );
  }
  return homes;
}

async function main() {
  return withOwnedV3CargoTarget(async (build) => {
    const sourceBin = await buildV3Cli(build);
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
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[install-v3-cli] ${reason}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
  }
}
