import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = path.join(root, 'scripts/appsdk-project-lifecycle-adapter.mjs');

test('unsupported lifecycle producer fails before creating records', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-adapter-contract-'));
  try {
    fs.mkdirSync(path.join(sandbox, 'scripts'));
    fs.copyFileSync(adapter, path.join(sandbox, 'scripts/adapter.mjs'));
    const result = spawnSync(process.execPath, [path.join(sandbox, 'scripts/adapter.mjs'),
      '--module', 'routecodex-v4-runtime'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LIFECYCLE_CAPABILITY_MISSING/);
    assert.deepEqual(fs.readdirSync(sandbox), ['scripts']);
  } finally {
    fs.rmSync(sandbox, { recursive: true });
  }
});

test('deployed CLI smoke cannot substitute the source binary', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/test-cli-plugin.mjs'),
    '--binary', '/usr/bin/false'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /false version/);
});

test('missing explicit deployed binary fails', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/test-cli-plugin.mjs'),
    '--binary'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an installed executable path/);
});
