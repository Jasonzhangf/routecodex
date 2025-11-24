#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skip = String(process.env.ROUTECODEX_SKIP_CORE_BUILD || process.env.SKIP_CORE_BUILD || '').trim().toLowerCase();
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const proj = path.join(root, 'sharedmodule', 'llmswitch-core', 'tsconfig.json');
const outDir = path.join(root, 'sharedmodule', 'llmswitch-core', 'dist');
const requiredOutputs = [
  path.join(outDir, 'v2', 'bridge', 'routecodex-adapter.js'),
  path.join(outDir, 'v2', 'conversion', 'conversion-v3', 'config', 'index.js')
];

function fail(msg){ console.error(`[build-core] ${msg}`); process.exit(2); }

function distIsValid() {
  if (!fs.existsSync(outDir)) return false;
  return requiredOutputs.every(file => fs.existsSync(file));
}

if (!fs.existsSync(tsc)) fail('TypeScript not installed in root node_modules. Run npm i.');
if (!fs.existsSync(proj)) {
  console.log('[build-core] llmswitch-core source not found under sharedmodule; skip local core build (依赖包将用于运行/打包)');
  process.exit(0);
}

// Allow skip via env or if dist already present
if (skip === '1' || skip === 'true' || skip === 'yes') {
  console.log('[build-core] skip requested by env (ROUTECODEX_SKIP_CORE_BUILD/SKIP_CORE_BUILD)');
  process.exit(0);
}
if (distIsValid()) {
  console.log('[build-core] dist already built; skip rebuild:', outDir);
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
