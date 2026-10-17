#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = path.join(repo, 'v3/scripts/architecture/verify-v3-provider-session-cooldown.mjs');
const files = { resources: 'v3-resource-operation-map.yml', functions: 'v3-function-map.yml', mainline: 'v3-mainline-call-map.yml' };
const inputs = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, YAML.parse(fs.readFileSync(path.join(repo, 'docs/architecture', file), 'utf8'))]));
const resource = (d, id) => d.resources.resources.find((row) => row.resource_id === id);
const feature = (d) => d.functions.features.find((row) => row.feature_id === 'v3.debug_error_foundation');
const edge = (d, id) => d.mainline.chains.find((row) => row.chain_id === 'v3.debug_error_foundation.mainline').edges.find((row) => row.step_id === id);
const cases = [
  ['HTTP control reader removed', (d) => { const r = resource(d, 'v3.server.validated_http_input'); r.allowed_readers = r.allowed_readers.filter((v) => v !== 'build_v3_provider_failure_session_scope_for_request'); }, /Validated HTTP input must bind/],
  ['scope resource removed', (d) => { resource(d, 'v3.provider.failure_session_scope').resource_id = 'removed'; }, /missing v3\.provider\.failure_session_scope resource/],
  ['Health writes Error scope', (d) => { resource(d, 'v3.provider.failure_session_scope').allowed_writers = ['V3ProviderHealthStore::record_provider_failure_in_session']; }, /scope writer must be only/],
  ['scope builder targets Health', (d) => { edge(d, 'v3-de-18').to_node = 'V3ProviderHealthStateMutated'; }, /v3-de-18 must produce typed scope/],
  ['scope builder produces Health', (d) => { edge(d, 'v3-de-18').resource_flow.produces = ['v3.provider.health_state']; }, /v3-de-18 must produce and write|must not claim provider health/],
  ['Health identity loses scope', (d) => { resource(d, 'v3.provider.health_state').identity = ['providerId', 'authAlias', 'modelId']; }, /bind provider health state identity/],
  ['Runtime owns Health writes', (d) => { resource(d, 'v3.provider.health_state').allowed_writers.push('V3ProviderFailureRuntimeHealth::record_provider_failure_record'); }, /Runtime wrappers must not own/],
  ['function binds removed global mutation', (d) => { const f = feature(d); f.entry_symbols = f.entry_symbols.map((v) => v === 'V3ProviderHealthStore::record_provider_failure_in_session' ? 'V3ProviderHealthStore::record_provider_failure' : v); }, /Function owner must bind scoped|Function owner must not retain/],
  ['failure edge calls global mutation', (d) => { edge(d, 'v3-de-14').callee_symbol = 'V3ProviderHealthStore::record_provider_failure'; }, /v3-de-14 must bind scoped health/],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-cooldown-data-'));
function write(doc) {
  const dir = path.join(tmp, 'docs/architecture');
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, file] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), YAML.stringify(doc[key]));
}
function run() {
  const r = spawnSync(process.execPath, [verifier], { cwd: repo, env: { ...process.env, V3_PROVIDER_SESSION_COOLDOWN_ROOT: tmp }, encoding: 'utf8' });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
try {
  write(inputs);
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.output);
  for (const [name, mutate, diagnostic] of cases) {
    const doc = structuredClone(inputs);
    mutate(doc);
    write(doc);
    const result = run();
    assert.equal(result.status, 1, `${name}: ${result.output}`);
    assert.match(result.output, diagnostic, name);
  }
  console.log(`V3 provider session cooldown GREEN baseline + ${cases.length} data mutations rejected.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
