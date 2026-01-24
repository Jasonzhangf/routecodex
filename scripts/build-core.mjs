#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skip = String(process.env.ROUTECODEX_SKIP_CORE_BUILD || process.env.SKIP_CORE_BUILD || '').trim().toLowerCase();
const buildModeRaw = String(process.env.BUILD_MODE || process.env.RCC_BUILD_MODE || 'release').toLowerCase();
const buildMode = buildModeRaw === 'dev' ? 'dev' : 'release';
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const proj = path.join(root, 'sharedmodule', 'llmswitch-core', 'tsconfig.json');
const coreRoot = path.join(root, 'sharedmodule', 'llmswitch-core');
const outDir = path.join(coreRoot, 'dist');
const requiredOutputs = [
  path.join(outDir, 'bridge', 'routecodex-adapter.js'),
  path.join(outDir, 'conversion', 'hub', 'response', 'provider-response.js'),
  // RouteCodex runtime loads this module via llmswitch bridge; ensure dev builds produce it.
  path.join(outDir, 'router', 'virtual-router', 'error-center.js')
];

function fail(msg){ console.error(`[build-core] ${msg}`); process.exit(2); }

function distIsValid() {
  if (!fs.existsSync(outDir)) return false;
  return requiredOutputs.every(file => fs.existsSync(file));
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function walkLatestMtime(entry) {
  let latest = 0;
  if (!fs.existsSync(entry)) return latest;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(entry, { withFileTypes: true });
    for (const dirent of entries) {
      if (dirent.name === 'dist' || dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue;
      latest = Math.max(latest, walkLatestMtime(path.join(entry, dirent.name)));
    }
  } else {
    latest = Math.max(latest, stat.mtimeMs || 0);
  }
  return latest;
}

function latestSourceMtime() {
  const candidates = [
    path.join(coreRoot, 'src'),
    path.join(coreRoot, 'interpreter'),
    path.join(coreRoot, 'exporters'),
    path.join(coreRoot, 'package.json'),
    path.join(coreRoot, 'tsconfig.json')
  ];
  return candidates.reduce((max, candidate) => Math.max(max, walkLatestMtime(candidate)), 0);
}

function earliestDistMtime() {
  const times = requiredOutputs.map(getFileMtime).filter(Boolean);
  if (!times.length) return 0;
  return Math.min(...times);
}

function shouldSkipBuild() {
  if (!distIsValid()) return false;
  const srcMtime = latestSourceMtime();
  if (!srcMtime) return false;
  const distMtime = earliestDistMtime();
  if (!distMtime) return false;
  return distMtime >= srcMtime;
}

if (!fs.existsSync(tsc)) fail('TypeScript not installed in root node_modules. Run npm i.');
if (!fs.existsSync(proj)) {
  console.log('[build-core] llmswitch-core source not found under sharedmodule; skip local core build (依赖包将用于运行/打包)');
  process.exit(0);
}

// 标准流程：release 构建必须依赖 npm 包（@jsonstudio/llms），禁止编译本地 sharedmodule。
if (buildMode !== 'dev') {
  console.log('[build-core] BUILD_MODE=release: skip local llmswitch-core build (use npm @jsonstudio/llms)');
  process.exit(0);
}

// Allow skip via env or if dist already present
if (skip === '1' || skip === 'true' || skip === 'yes') {
  console.log('[build-core] skip requested by env (ROUTECODEX_SKIP_CORE_BUILD/SKIP_CORE_BUILD)');
  process.exit(0);
}
if (shouldSkipBuild()) {
  console.log('[build-core] dist up-to-date; skip rebuild:', outDir);
  process.exit(0);
}

console.log('[build-core] Dist missing or invalid, compiling llmswitch-core...');

const res = spawnSync(process.execPath, [tsc, '-p', proj], { stdio: 'inherit' });
if ((res.status ?? 0) !== 0) {
  console.error('[build-core] TypeScript build failed for llmswitch-core. Fallback is disabled.');
  process.exit(res.status ?? 2);
}

if (!distIsValid()) fail('llmswitch-core dist not produced or missing required outputs');
console.log('[build-core] llmswitch-core built:', outDir);
