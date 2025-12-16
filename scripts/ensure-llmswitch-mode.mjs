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
const nodeModulesScope = path.join(PROJECT_ROOT, 'node_modules', '@jsonstudio');
const llmsPath = path.join(nodeModulesScope, 'llms');

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
        console.log('[llmswitch:ensure] dev link ok: node_modules/@jsonstudio/llms -> sharedmodule/llmswitch-core');
        return;
      }
    }
  }
  console.log('[llmswitch:ensure] linking dev core: node_modules/@jsonstudio/llms -> sharedmodule/llmswitch-core');
  runNodeScript('scripts/link-llmswitch.mjs');
}

function ensureReleasePackage() {
  if (isSymlink(llmsPath)) {
    console.log('[llmswitch:ensure] release mode: unlinking node_modules/@jsonstudio/llms symlink');
    runNodeScript('scripts/link-llmswitch.mjs', ['unlink']);
  }
  const pkgPath = path.join(llmsPath, 'package.json');
  if (!exists(pkgPath)) {
    console.log('[llmswitch:ensure] BUILD_MODE=release: installing @jsonstudio/llms via npm (missing in node_modules)');
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    if ((res.status ?? 0) !== 0) {
      process.exit(res.status ?? 2);
    }
    if (!exists(pkgPath)) {
      console.error('[llmswitch:ensure] npm install completed but @jsonstudio/llms is still missing');
      process.exit(2);
    }
  }
  console.log('[llmswitch:ensure] release package ok: using npm-installed @jsonstudio/llms');
}

if (mode === 'dev') {
  ensureDevLink();
} else {
  ensureReleasePackage();
}
