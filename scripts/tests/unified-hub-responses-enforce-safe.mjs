#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runCase(args) {
  const nodeArgs = ['scripts/unified-hub-shadow-compare.mjs', ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`shadow compare failed: ${nodeArgs.join(' ')}`);
  }
}

function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'unified-hub');

  runCase([
    '--request',
    path.join(fixturesDir, 'responses.clean.json'),
    '--entry-endpoint',
    '/v1/responses',
    '--route-hint',
    'responses',
    '--baseline-mode',
    'off',
    '--candidate-mode',
    'enforce'
  ]);

  console.log('[unified-hub-responses-enforce-safe] OK');
}

main();

