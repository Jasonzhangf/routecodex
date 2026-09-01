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
const adminBinaryName = process.platform === 'win32' ? 'rccv3-admin.exe' : 'rccv3-admin';
const repoBin = path.join(v3Root, 'dist', 'bin', binaryName);
const repoAdminBin = path.join(v3Root, 'dist', 'bin', adminBinaryName);

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
  const v3TempDir = path.join(v3Root, 'build-control', 'temp');
  fs.mkdirSync(v3TempDir, { recursive: true });
  env.TMPDIR = v3TempDir;
  env.TMP = v3TempDir;
  env.TEMP = v3TempDir;
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
      await waitForOwnedPidsExit(build.interruptedPids);
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

function signalOwnedChild(build, signal) {
  if (Number.isInteger(build.activeChildRootPid) && build.activeChildRootPid > 0) {
    try {
      process.kill(build.activeChildRootPid, signal);
      return [build.activeChildRootPid];
    } catch (error) {
      if (error?.code === 'ESRCH') {
        return [];
      }
      throw error;
    }
  }
  if (build.activeChild && !build.activeChild.killed) {
    build.activeChild.kill(signal);
  }
  return [];
}

async function waitForOwnedPidsExit(pids) {
  for (const pid of pids ?? []) {
    while (processExists(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitForOwnedTargetSafeToRemove(build) {
  if (Number.isInteger(build.activeChildRootPid) && build.activeChildRootPid > 0) {
    await waitForOwnedPidsExit([build.activeChildRootPid]);
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
    '-p',
    'routecodex-v3-admin',
  ], {
    cwd: v3Root,
    env,
    stdio: 'inherit',
  }, build, 'cargo build for routecodex-v3-cli');
  const sourceBin = path.join(cargoTargetDir, 'release', binaryName);
  if (!fs.existsSync(sourceBin)) {
    fail(`built V3 CLI binary not found: ${sourceBin}`);
  }
  const sourceAdminBin = path.join(cargoTargetDir, 'release', adminBinaryName);
  if (!fs.existsSync(sourceAdminBin)) {
    fail(`built V3 Admin binary not found: ${sourceAdminBin}`);
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
      build.interruptedPids = signalOwnedChild(build, signal);
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
  try {
    fs.copyFileSync(sourcePath, tempPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(tempPath, 0o755);
    }
    if (sign) {
      signExecutable(tempPath);
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      fail(`cannot publish ${targetPath}: install target directory is not writable (${error.code}); check ownership and permissions for ${path.dirname(targetPath)}`);
    }
    throw error;
  }
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
  try {
    fs.symlinkSync(path.basename(binaryPath), temporaryPath);
    fs.renameSync(temporaryPath, aliasPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      fail(`cannot publish ${aliasPath}: install target directory is not writable (${error.code}); check ownership and permissions for ${path.dirname(aliasPath)}`);
    }
    throw error;
  }
}

async function main() {
  await import('./bump-version.mjs');
  return withOwnedV3CargoTarget(async (build) => {
    const sourceBin = await buildV3Cli(build);
    copyExecutableAtomic(sourceBin, repoBin);
    copyExecutableAtomic(path.join(path.dirname(sourceBin), adminBinaryName), repoAdminBin);
    const expectedHash = sha256(repoBin);
    console.log(`[install-cli] installed repo ${path.relative(v3Root, repoBin)} sha256=${expectedHash}`);
    console.log(`[install-cli] installed repo ${path.relative(v3Root, repoAdminBin)} sha256=${sha256(repoAdminBin)}`);

    const installBin = path.join(resolveInstallBinDir(), binaryName);
    copyExecutableAtomic(repoBin, installBin, { sign: false });
    const installAdminBin = path.join(resolveInstallBinDir(), adminBinaryName);
    copyExecutableAtomic(repoAdminBin, installAdminBin, { sign: false });
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
    console.log(`[install-cli] installed ${installAdminBin} sha256=${sha256(installAdminBin)}`);
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
