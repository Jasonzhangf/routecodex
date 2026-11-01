#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = path.join(repo, 'v3/scripts/architecture/verify-v3-hub-relay-runtime-closeout.mjs');
const files = {
  manifest: 'docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml',
  functions: 'docs/architecture/v3-function-map.yml',
  mainline: 'docs/architecture/v3-mainline-call-map.yml',
  verification: 'docs/architecture/v3-verification-map.yml',
};
const inputs = Object.fromEntries(Object.entries(files).map(([key, relative]) => [key, YAML.parse(fs.readFileSync(path.join(repo, relative), 'utf8'))]));
const failureChain = (d) => d.mainline.chains.find((row) => row.chain_id === 'v3.hub_relay.response_failure_entry');
const cases = [
  ['non-adjacent closeout shortcut', (d) => { d.manifest.edges[2].to_node = 'V3HubReqTarget06Resolved'; }, /edge v3-hub-relay-closeout-03 mismatch/],
  ['manifest owner drift', (d) => { d.manifest.owner_feature_id = 'v3.hub_relay_gate_review_surface'; }, /owner_feature_id mismatch/],
  ['failure entry removed', (d) => { failureChain(d).edges = failureChain(d).edges.filter((edge) => edge.step_id !== 'v3-hub-relay-response-failure-01'); }, /missing v3-hub-relay-response-failure-01/],
  ['failure entry wrong callee', (d) => { failureChain(d).edges.find((edge) => edge.step_id === 'v3-hub-relay-response-failure-01').callee_symbol = 'provider_response_hook_failure'; }, /callee_symbol must equal build_v3_error_01_source_raised_external/],
];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-runtime-closeout-data-'));
function run(doc) {
  for (const [key, relative] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, YAML.stringify(doc[key]));
  }
  const r = spawnSync(process.execPath, [verifier], { cwd: repo, env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root }, encoding: 'utf8' });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
try {
  const baseline = run(inputs);
  assert.equal(baseline.status, 0, baseline.output);
  for (const [name, mutate, diagnostic] of cases) {
    const doc = structuredClone(inputs);
    mutate(doc);
    const result = run(doc);
    assert.equal(result.status, 1, `${name}: ${result.output}`);
    assert.match(result.output, diagnostic, name);
  }
  console.log('[test:v3-hub-relay-runtime-closeout-red-fixtures] GREEN baseline + 4 data mutations rejected');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
