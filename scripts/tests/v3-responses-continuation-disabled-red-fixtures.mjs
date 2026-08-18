#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-responses-continuation-disabled.mjs');
const kernel = 'v3/crates/routecodex-v3-runtime/src/kernel.rs';
const copied = [
  kernel,
  'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs',
  'docs/goals/v3-responses-direct-remote-continuation-integration-test-design.md',
];
const root = mkdtempSync(join(tmpdir(), 'v3-continuation-disabled-red-'));

try {
  for (const path of copied) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(repo, path), destination);
  }
  const target = resolve(root, kernel);
  const source = readFileSync(target, 'utf8');
  const from = '                if !continuation_disabled {';
  const to = '                if true {';
  if (!source.includes(from)) throw new Error('SSE disabled continuation gate mutation source missing');
  writeFileSync(target, source.replace(from, to));
  const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0 || !/continuation_disabled/.test(output)) {
    throw new Error(`disabled continuation mutation was not rejected: ${output.slice(-500)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('[test:v3-responses-continuation-disabled-red-fixtures] ok');
