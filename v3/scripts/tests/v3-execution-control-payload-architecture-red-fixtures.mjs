#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = path.join(repoRoot, 'v3/scripts/architecture/verify-v3-execution-control-payload-architecture.mjs');
const files = {
  manifest: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
  resources: 'docs/architecture/v3-resource-operation-map.yml',
  functions: 'docs/architecture/v3-function-map.yml',
  calls: 'docs/architecture/v3-mainline-call-map.yml',
  modules: 'docs/architecture/v3-runtime-module-registry.yml',
};
const inputs = Object.fromEntries(Object.entries(files).map(([name, file]) =>
  [name, YAML.parse(readFileSync(path.join(repoRoot, file), 'utf8'))]));
const chain = (doc) => doc.calls.chains.find((row) => row.chain_id === doc.manifest.lifecycle_id);
const cases = [
  ['sealed replay becomes optional', (d) => { d.manifest.sealed_replay_body_contract.anthropic = 'optional_stream'; }, /Anthropic sealed replay body must be typed and non-optional/],
  ['lifecycle status loses active binding', (d) => { d.manifest.status = 'runtime_red'; }, /lifecycle status must be active/],
  ['manifest edge loses active binding', (d) => { d.manifest.edges[0].status = 'binding_pending'; }, /edge .* must be active/],
  ['call edge loses active binding', (d) => { chain(d).edges[0].status = 'runtime_red'; }, /must be active or anchored/],
  ['request budget becomes optional', (d) => { d.manifest.budget_contract.per_request = 'optional'; }, /missing budget per_request/],
  ['disk spill becomes fallback', (d) => { d.manifest.budget_contract.disk_spill = 'allowed'; }, /initial disk spill must be forbidden/],
  ['local resource attribution disappears', (d) => { d.manifest.failure_kinds = d.manifest.failure_kinds.filter((kind) => kind !== 'LocalResourceExhausted'); }, /missing failure kind LocalResourceExhausted/],
  ['attempt budget resource disappears', (d) => { d.resources.resources = d.resources.resources.filter((row) => row.resource_id !== 'v3.execution.attempt_budget'); }, /missing manifest resource v3\.execution\.attempt_budget/],
  ['lifecycle owner disappears', (d) => { d.functions.features = d.functions.features.filter((row) => row.feature_id !== 'v3.execution_request_lifecycle'); }, /missing feature v3\.execution_request_lifecycle/],
  ['call edge endpoints drift', (d) => { chain(d).edges[0].to_node = 'unrelated_node'; }, /edge endpoints drift/],
  ['runtime responsibility disappears', (d) => { d.modules.responsibility_contracts = d.modules.responsibility_contracts.filter((row) => row.contract_id !== 'v3.execution_control_payload.runtime'); }, /missing responsibility v3\.execution_control_payload\.runtime/],
  ['execution-control owner drifts', (d) => { d.manifest.implementation_owner_files.request_execution_control = 'v3/crates/routecodex-v3-runtime/src/nodes.rs'; }, /request_execution_control owner mismatch/],
  ['local replay becomes provider failure', (d) => { d.manifest.failure_attribution_contract.responses_client_replay.provider_response_classification = 'allowed'; }, /must remain provider-health neutral/],
  ['internal failure becomes client error projection', (d) => { d.manifest.failure_attribution_contract.responses_client_replay.client_error_projection = 'allowed'; }, /without client error projection/],
];

const root = mkdtempSync(path.join(tmpdir(), 'v3-execution-control-data-'));
function writeInputs(doc) {
  for (const [name, file] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, YAML.stringify(doc[name]));
  }
}
function run() {
  const result = spawnSync(process.execPath, [verifier], {
    cwd: repoRoot,
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
try {
  writeInputs(inputs);
  const baseline = run();
  assert.equal(baseline.status, 0, `baseline: ${baseline.output}`);
  for (const [name, mutate, diagnostic] of cases) {
    const doc = structuredClone(inputs);
    mutate(doc);
    writeInputs(doc);
    const result = run();
    assert.equal(result.status, 1, `${name}: ${result.output}`);
    assert.match(result.output, diagnostic, name);
  }
  console.log(`[test:v3-execution-control-payload-architecture-red-fixtures] ok (GREEN baseline, ${cases.length} data mutations rejected)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
