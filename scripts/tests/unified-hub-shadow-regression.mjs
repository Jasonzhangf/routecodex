#!/usr/bin/env node
import fs from 'node:fs';
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
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`fixtures dir missing: ${fixturesDir}`);
  }

  runCase([
    '--request',
    path.join(fixturesDir, 'chat.json'),
    '--entry-endpoint',
    '/v1/chat/completions',
    '--route-hint',
    'openai'
  ]);

  runCase([
    '--request',
    path.join(fixturesDir, 'responses.json'),
    '--entry-endpoint',
    '/v1/responses',
    '--route-hint',
    'responses'
  ]);

  runCase([
    '--request',
    path.join(fixturesDir, 'anthropic.json'),
    '--entry-endpoint',
    '/v1/messages',
    '--route-hint',
    'anthropic'
  ]);

  console.log('[unified-hub-shadow-regression] OK');
}

main();

