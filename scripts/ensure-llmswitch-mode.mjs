#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const rawMode = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase();
const mode = rawMode === 'dev' ? 'dev' : 'release';

const sharedCoreDir = path.join(PROJECT_ROOT, 'sharedmodule', 'llmswitch-core');
const nodeModulesScope = path.join(PROJECT_ROOT, 'node_modules');
const llmsPath = path.join(nodeModulesScope, 'rcc-llmswitch-core');

function runNodeScript(relativePath, args = []) {
  const scriptPath = path.join(PROJECT_ROOT, relativePath);
  const res = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if ((res.status ?? 0) !== 0) {
    process.exit(res.status ?? 2);
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readLink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDevLink() {
  if (!exists(sharedCoreDir)) {
    console.error(`[llmswitch:ensure] BUILD_MODE=dev 但未找到 ${sharedCoreDir}`);
    console.error('[llmswitch:ensure] 请先 clone sharedmodule/llmswitch-core，或改用 BUILD_MODE=release');
    process.exit(2);
  }
  if (isSymlink(llmsPath)) {
    const target = readLink(llmsPath);
    if (target) {
      const resolved = path.resolve(nodeModulesScope, target);
      const expected = path.resolve(sharedCoreDir);
      if (resolved === expected) {
        console.log('[llmswitch:ensure] dev link ok: node_modules/rcc-llmswitch-core -> sharedmodule/llmswitch-core');
        return;
      }
    }
  }
  console.log('[llmswitch:ensure] linking dev core: node_modules/rcc-llmswitch-core -> sharedmodule/llmswitch-core');
  runNodeScript('scripts/link-llmswitch.mjs');
}

function ensureReleasePackage() {
  if (isSymlink(llmsPath)) {
    console.log('[llmswitch:ensure] release mode: unlinking node_modules/rcc-llmswitch-core symlink');
    runNodeScript('scripts/link-llmswitch.mjs', ['unlink']);
  }
  const pkgPath = path.join(llmsPath, 'package.json');
  if (!exists(pkgPath)) {
    console.log('[llmswitch:ensure] BUILD_MODE=release: local package missing; expecting sharedmodule/llmswitch-core or node_modules/rcc-llmswitch-core');
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    if ((res.status ?? 0) !== 0) {
      process.exit(res.status ?? 2);
    }
    if (!exists(pkgPath)) {
      console.error('[llmswitch:ensure] npm install completed but rcc-llmswitch-core is still missing');
      process.exit(2);
    }
  }
  console.log('[llmswitch:ensure] release package ok: using local rcc-llmswitch-core package');
}

if (exists(sharedCoreDir)) {
  const banner = mode === 'dev'
    ? '[llmswitch:ensure] BUILD_MODE=dev: prefer local sharedmodule/llmswitch-core'
    : '[llmswitch:ensure] BUILD_MODE=release but local sharedmodule/llmswitch-core exists; prefer local core';
  console.log(banner);
  ensureDevLink();
} else if (mode === 'dev') {
  ensureDevLink();
} else {
  ensureReleasePackage();
}
