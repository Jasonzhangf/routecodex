#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveShimDirs() {
  if (process.env.ROUTECODEX_SHIM_DIR) {
    return [path.resolve(process.env.ROUTECODEX_SHIM_DIR)];
  }
  return [path.join(os.homedir(), '.local', 'bin')];
}

function removeExistingShimPath(shimPath) {
  try {
    const stat = fs.lstatSync(shimPath);
    if (stat.isDirectory()) {
      throw new Error(`refusing to replace directory CLI shim: ${shimPath}`);
    }
    fs.rmSync(shimPath, { force: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function removeLegacyShim(shimDir, binName) {
  if (process.platform === 'win32') {
    return;
  }
  removeExistingShimPath(path.join(shimDir, binName));
}

function installDirectNativeCommand(shimDir, binName, binaryPath) {
  if (process.platform === 'win32') {
    return null;
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`direct V3 binary missing: ${binaryPath}`);
  }
  if (binName === 'rccv3') {
    return binaryPath;
  }

  const shimPath = path.join(shimDir, binName);
  removeExistingShimPath(shimPath);
  fs.symlinkSync(path.basename(binaryPath), shimPath);
  return shimPath;
}

function main() {
  const installed = [];
  const shimDirs = resolveShimDirs();
  for (const shimDir of shimDirs) {
    fs.mkdirSync(shimDir, { recursive: true });
    const binaryPath = path.join(shimDir, process.platform === 'win32' ? 'rccv3.exe' : 'rccv3');
    removeLegacyShim(shimDir, 'routecodex-v3');
    installed.push(installDirectNativeCommand(shimDir, 'routecodex', binaryPath));
    installed.push(installDirectNativeCommand(shimDir, 'rcc', binaryPath));
    installed.push(installDirectNativeCommand(shimDir, 'rccv3', binaryPath));
  }

  for (const file of installed.filter(Boolean)) {
    console.log(`[cli-shim] installed ${file}`);
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const missing = shimDirs.filter((dir) => !pathEntries.includes(dir));
  for (const dir of missing) {
    console.warn(`[cli-shim] warning: ${dir} is not in PATH`);
  }
}

main();
