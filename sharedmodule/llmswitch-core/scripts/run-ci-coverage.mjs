#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const c8Bin = path.join(projectRoot, 'node_modules', 'c8', 'bin', 'c8.js');
const verifyCoverage = path.join(projectRoot, 'scripts', 'verify-coverage.mjs');
const verifyShadowGateAll = path.join(projectRoot, 'scripts', 'verify-shadow-gate-all.mjs');
const matrix = path.join(projectRoot, 'scripts', 'tests', 'run-matrix-ci.mjs');

const env = {
  ...process.env,
  // CI should be deterministic: never mutate package.json/package-lock.json during builds.
  LLMS_SKIP_VERSION_BUMP: process.env.LLMS_SKIP_VERSION_BUMP ?? '1',
  // For coverage we need sourcemaps/inline sources.
  LLMSWITCH_MATRIX_BUILD_SCRIPT: process.env.LLMSWITCH_MATRIX_BUILD_SCRIPT ?? 'build:coverage'
};

const args = [
  c8Bin,
  '--reporter=json-summary',
  '--reporter=text',
  '--reporter=lcov',
  '--report-dir=coverage',
  '--exclude=scripts/**',
  '--exclude=tests/**',
  process.execPath,
  matrix
];

const run = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: projectRoot, env });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const verify = spawnSync(process.execPath, [verifyCoverage], { stdio: 'inherit', cwd: projectRoot, env });
if (verify.status !== 0) {
  process.exit(verify.status ?? 1);
}

const shadowGateArgs = [verifyShadowGateAll];
const shadowGateFilter = String(process.env.LLMS_SHADOW_GATE_FILTER ?? '').trim();
if (shadowGateFilter) {
  shadowGateArgs.push('--filter', shadowGateFilter);
}

const verifyShadow = spawnSync(process.execPath, shadowGateArgs, {
  stdio: 'inherit',
  cwd: projectRoot,
  env
});
process.exit(verifyShadow.status ?? 1);
