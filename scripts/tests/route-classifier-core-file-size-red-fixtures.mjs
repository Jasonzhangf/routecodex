#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const gate = path.join(
  repoRoot,
  'scripts/architecture/verify-route-classifier-core-file-size.mjs'
);

function runFixture(lineCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-classifier-size-'));
  fs.writeFileSync(path.join(root, 'lib.rs'), `${'fn x() {}\n'.repeat(lineCount)}`);
  return spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    env: { ...process.env, ROUTECODEX_ROUTE_CLASSIFIER_CORE_ROOT: root },
    encoding: 'utf8'
  });
}

const positive = runFixture(20);
assert.equal(positive.status, 0, positive.stderr || positive.stdout);

const negative = runFixture(501);
assert.notEqual(negative.status, 0, '501-line Rust source must fail the gate');
assert.match(negative.stderr, /files exceed 500 lines/);

console.log('[test:route-classifier-core-file-size-red-fixtures] ok');
