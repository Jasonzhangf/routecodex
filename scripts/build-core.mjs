#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const proj = path.join(root, 'sharedmodule', 'llmswitch-core', 'tsconfig.json');
const outDir = path.join(root, 'sharedmodule', 'llmswitch-core', 'dist');

function fail(msg){ console.error(`[build-core] ${msg}`); process.exit(2); }

if (!fs.existsSync(tsc)) fail('TypeScript not installed in root node_modules. Run npm i.');
if (!fs.existsSync(proj)) {
  console.log('[build-core] llmswitch-core source not found in sharedmodule; skipping local build');
  process.exit(0);
}

console.log('[build-core] Compiling llmswitch-core with root TypeScript...');
const res = spawnSync(process.execPath, [tsc, '-p', proj], { stdio: 'inherit' });
if ((res.status ?? 0) !== 0) {
  console.warn('[build-core] TypeScript build failed for llmswitch-core, falling back to node_modules dist');
  process.exit(0);
}

if (!fs.existsSync(outDir)) fail('llmswitch-core dist not produced');
console.log('[build-core] llmswitch-core built:', outDir);
