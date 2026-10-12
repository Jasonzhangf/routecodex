#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const v3Root = join(repoRoot, 'v3');
const testDir = join(v3Root, 'scripts', 'tests', 'protocol-live-mock');

function runCommand(command) {
  console.log(`[protocol-live-mock-support] ${command.label}`);
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`[protocol-live-mock-support] FAIL ${command.label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[protocol-live-mock-support] FAIL ${command.label}: exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
const testPaths = testFiles.map((name) => join('v3', 'scripts', 'tests', 'protocol-live-mock', name));

runCommand({
  cwd: v3Root,
  command: process.execPath,
  args: ['--check', 'scripts/tests/v3-protocol-live-mock-matrix.mjs'],
  label: 'static:v3:runner',
});
runCommand({
  cwd: repoRoot,
  command: process.execPath,
  args: ['--test', '--test-concurrency=1', '--test-timeout=120000', ...testPaths],
  label: 'support:node-tests',
});

console.log(`[protocol-live-mock-support] PASS ${testPaths.length}/${testFiles.length} node test files`);
