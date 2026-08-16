#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const v3Root = path.resolve(__dirname, '..');
const manifestPath = path.join(v3Root, 'Cargo.toml');
const packageJsonPath = path.join(v3Root, 'package.json');
const isolationGate = path.join(v3Root, 'scripts', 'verify-isolation.mjs');
const binaryName = process.platform === 'win32' ? 'rccv3.exe' : 'rccv3';
const repoBin = path.join(v3Root, 'dist', 'bin', binaryName);

function readPackageVersion() {
  if (!fs.existsSync(packageJsonPath)) {
    fail(`source package.json missing: ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) {
    fail(`source package version missing: ${packageJsonPath}`);
  }
  return version;
}

export function buildV3CargoEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  env.ROUTECODEX_BUILD_VERSION = readPackageVersion();
  if (!Object.prototype.hasOwnProperty.call(env, 'CARGO_NET_OFFLINE')) {
    env.CARGO_NET_OFFLINE = 'true';
  }
  const ownsCargoTargetDir = !env.CARGO_TARGET_DIR;
  if (ownsCargoTargetDir) {
    fs.mkdirSync(path.join(v3Root, 'build-control', 'install-target'), { recursive: true });
  }
  const cargoTargetDir = ownsCargoTargetDir
    ? fs.mkdtempSync(path.join(v3Root, 'build-control', 'install-target', 'run-'))
    : path.resolve(env.CARGO_TARGET_DIR);
  const relativeTarget = path.relative(v3Root, cargoTargetDir);
  if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    fail(`external CARGO_TARGET_DIR is forbidden: ${cargoTargetDir}`);
  }
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

async function buildV3Cli(build) {
  const { env, cargoTargetDir } = build;
  if (!fs.existsSync(manifestPath)) {
    fail(`missing V3 manifest: ${manifestPath}`);
  }
  await runInterruptibleCommand(process.execPath, [isolationGate], {
    cwd: v3Root,
    env,
    stdio: 'inherit',
  }, build, 'V3 install isolation gate');
  await runInterruptibleCommand(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'test:distribution'],
    {
      cwd: v3Root,
      env,
      stdio: 'inherit',
    },
    build,
    'V3 CLI distribution gate',
  );
  await runInterruptibleCommand('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    manifestPath,
    '-p',
    'routecodex-v3-cli',
  ], {
    cwd: v3Root,
    env,
    stdio: 'inherit',
  }, build, 'cargo build for routecodex-v3-cli');
  const sourceBin = path.join(cargoTargetDir, 'release', binaryName);
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

function copyExecutableAtomic(sourcePath, targetPath, { sign = true } = {}) {
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
  if (sign) {
    signExecutable(tempPath);
  }
  fs.renameSync(tempPath, targetPath);
}

function signExecutable(targetPath) {
  if (process.platform === 'win32') {
    return;
  }
  const result = spawnSync('codesign', ['-s', '-', '-f', targetPath], {
    cwd: v3Root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    fail(`ad hoc code signing failed for ${targetPath}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveInstallBinDir() {
  return path.join(resolveHomeDir(), '.local', 'bin');
}

function installAliasAtomic(aliasPath, binaryPath) {
  const temporaryPath = path.join(
    path.dirname(aliasPath),
    `.${path.basename(aliasPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.rmSync(temporaryPath, { force: true });
  fs.symlinkSync(path.basename(binaryPath), temporaryPath);
  fs.renameSync(temporaryPath, aliasPath);
}

async function main() {
  return withOwnedV3CargoTarget(async (build) => {
    const sourceBin = await buildV3Cli(build);
    copyExecutableAtomic(sourceBin, repoBin);
    const expectedHash = sha256(repoBin);
    console.log(`[install-cli] installed repo ${path.relative(v3Root, repoBin)} sha256=${expectedHash}`);

    const installBin = path.join(resolveInstallBinDir(), binaryName);
    copyExecutableAtomic(repoBin, installBin, { sign: false });
    const actualHash = sha256(installBin);
    if (actualHash !== expectedHash) {
      fail(`hash mismatch after installing ${installBin}`);
    }
    for (const alias of ['routecodex', 'rcc']) {
      const aliasPath = path.join(resolveInstallBinDir(), alias);
      installAliasAtomic(aliasPath, installBin);
      if (fs.realpathSync(aliasPath) !== fs.realpathSync(installBin)) {
        fail(`alias does not resolve to installed V3 binary: ${aliasPath}`);
      }
    }
    console.log(`[install-cli] installed ${installBin} sha256=${actualHash}`);
    console.log('[install-cli] ok: installed direct V3 binary without root or release snapshot inputs');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[install-cli] ${reason}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
  }
}
