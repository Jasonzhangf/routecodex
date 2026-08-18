import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('direct SSE runtime remains compilable', () => {
  const result = spawnSync(
    'cargo',
    ['check', '--manifest-path', 'v3/Cargo.toml', '-p', 'routecodex-v3-runtime'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
    },
  );

  assert.equal(
    result.status,
    0,
    `routecodex-v3-runtime compile regression:\n${result.stdout}\n${result.stderr}`,
  );
});
