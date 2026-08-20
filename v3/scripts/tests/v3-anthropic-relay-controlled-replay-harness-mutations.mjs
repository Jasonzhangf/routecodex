#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const mutations = [
  ['unsorted manifest', 'v3/fixtures/anthropic-relay-controlled-upstream/manifest.json', '"json_thinking_tool_use",\n    "provider_error"', '"provider_error",\n    "json_thinking_tool_use"', /manifest cases/],
  ['missing SSE case', 'v3/fixtures/anthropic-relay-controlled-upstream/manifest.json', '    "sse_thinking_tool_use"', '    "sse_removed"', /manifest cases/],
  ['provider error becomes success', 'v3/fixtures/anthropic-relay-controlled-upstream/provider_error.json', '"status": 429', '"status": 200', /provider error scenario/],
  ['provider side-channel leak', 'v3/fixtures/anthropic-relay-controlled-upstream/side_channel_isolation.json', '"model": "responses-wire-model"', '"model": "responses-wire-model", "metadata_center": {"leak": true}', /side-channel field/],
  ['missing red diagnostic', 'scripts/tests/v3-anthropic-relay-controlled-replay-harness.mjs', 'V3_ANTHROPIC_RELAY_WIRING_MISSING', 'V3_WIRING_UNKNOWN', /harness missing V3_ANTHROPIC_RELAY_WIRING_MISSING/],
  ['missing adjacent node', 'scripts/tests/v3-anthropic-relay-controlled-replay-harness.mjs', "  'V3HubReqExecution05Planned',\n", '', /harness missing V3HubReqExecution05Planned from REQUIRED_NODES/],
  ['capture enforcement removed', 'scripts/tests/v3-anthropic-relay-controlled-replay-harness.mjs', 'captured.length !== 1', 'captured.length < 0', /harness missing captured.length !== 1/],
];

const failures = [];
for (const [name, relative, from, to, diagnostic] of mutations) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-anthropic-relay-mutation-'));
  try {
    for (const directory of ['v3/fixtures/anthropic-relay-controlled-upstream', 'docs/goals', 'docs/schemas', 'scripts/architecture', 'scripts/tests']) {
      cpSync(resolve(repoRoot, directory), resolve(root, directory), { recursive: true });
    }
    const target = resolve(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: mutation source missing`);
    writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, ['scripts/architecture/verify-v3-anthropic-relay-controlled-replay-harness.mjs'], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: verifier unexpectedly passed`);
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
