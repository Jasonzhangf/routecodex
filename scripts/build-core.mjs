#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequiredCoreOutputs, distIsValid as isCoreDistValid } from './lib/build-core-utils.mjs';

const root = process.cwd();
const skip = String(process.env.ROUTECODEX_SKIP_CORE_BUILD || process.env.SKIP_CORE_BUILD || '').trim().toLowerCase();
const coreRoot = path.join(root, 'sharedmodule', 'llmswitch-core');
const nativeBuildScript = path.join(coreRoot, 'scripts', 'build-native-hotpath.mjs');
const outDir = path.join(coreRoot, 'dist');
const requiredOutputs = createRequiredCoreOutputs(outDir);

function fail(msg){ console.error(`[build-core] ${msg}`); process.exit(2); }

function distIsValid() {
  return isCoreDistValid(outDir, requiredOutputs);
}

function runNativeBuild() {
  if (!fs.existsSync(nativeBuildScript)) {
    fail(`native build script missing: ${nativeBuildScript}`);
  }
  const res = spawnSync(process.execPath, [nativeBuildScript], { stdio: 'inherit', cwd: coreRoot });
  if ((res.status ?? 0) !== 0) {
    fail('native build failed for llmswitch-core');
  }
}

if (!fs.existsSync(coreRoot)) {
  console.log('[build-core] llmswitch-core source not found under sharedmodule; skip local core build (依赖包将用于运行/打包)');
  process.exit(0);
}

// 有本地 sharedmodule/llmswitch-core 时，无论 dev/release 都以本地源码为唯一构建真源。
// 仅当 sharedmodule 缺失时，release 才允许退回 npm 包。
if (skip === '1' || skip === 'true' || skip === 'yes') {
  console.log('[build-core] skip requested by env (ROUTECODEX_SKIP_CORE_BUILD/SKIP_CORE_BUILD)');
  process.exit(0);
}
runNativeBuild();

if (!distIsValid()) {
  const missingOutputs = requiredOutputs
    .filter((file) => !fs.existsSync(file))
    .map((file) => path.relative(root, file));
  fail(`llmswitch-core dist not produced or missing required outputs: ${missingOutputs.join(', ')}`);
}
console.log('[build-core] llmswitch-core native dist ready:', outDir);
