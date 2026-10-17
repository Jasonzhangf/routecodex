#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repoRoot, 'v3/scripts/architecture/verify-v3-anthropic-relay-controlled-replay-harness.mjs');
const mutations = [
  ['unsorted manifest', 'v3/fixtures/anthropic-relay-controlled-upstream/manifest.json', '"json_thinking_tool_use",\n    "provider_error"', '"provider_error",\n    "json_thinking_tool_use"', /manifest cases/],
  ['missing SSE case', 'v3/fixtures/anthropic-relay-controlled-upstream/manifest.json', '    "sse_thinking_tool_use"', '    "sse_removed"', /manifest cases/],
  ['provider error becomes success', 'v3/fixtures/anthropic-relay-controlled-upstream/provider_error.json', '"status": 429', '"status": 200', /provider error scenario/],
  ['provider side-channel leak', 'v3/fixtures/anthropic-relay-controlled-upstream/side_channel_isolation.json', '"model": "responses-wire-model"', '"model": "responses-wire-model", "metadata_center": {"leak": true}', /side-channel field/],
];

const failures = [];
let baselineChecked = false;
for (const [name, relative, from, to, diagnostic] of mutations) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-anthropic-relay-mutation-'));
  try {
    cpSync(resolve(repoRoot, 'v3/fixtures/anthropic-relay-controlled-upstream'), resolve(root, 'v3/fixtures/anthropic-relay-controlled-upstream'), { recursive: true });
    mkdirSync(resolve(root, 'docs/schemas'), { recursive: true });
    cpSync(resolve(repoRoot, 'docs/schemas/v3-anthropic-relay-controlled-replay-evidence.schema.json'), resolve(root, 'docs/schemas/v3-anthropic-relay-controlled-replay-evidence.schema.json'));
    const options = { cwd: root, env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root }, encoding: 'utf8' };
    if (!baselineChecked) {
      const baseline = spawnSync(process.execPath, [verifier], options);
      if (baseline.status !== 0) throw new Error(`fixture baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
      baselineChecked = true;
    }
    const target = resolve(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, [verifier], options);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 1) failures.push(`${name}: unexpected verifier exit ${result.status}`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-anthropic-relay-controlled-replay-harness-mutations] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-anthropic-relay-controlled-replay-harness-mutations] ok (${mutations.length} mutations rejected)`);
