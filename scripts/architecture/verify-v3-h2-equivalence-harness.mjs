#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (file) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    failures.push(file + ': cannot read: ' + error.message);
    return '';
  }
};
const requireText = (file, text, label = text) => {
  if (!read(file).includes(text)) failures.push(file + ': missing ' + label);
};

const testFile = 'v3/crates/routecodex-v3-cli/tests/h2_p6_controlled_replay.rs';
const docFile = 'docs/goals/v3-hub-h2-p6-responses-direct-characterization.md';
const verificationFile = 'docs/architecture/v3-verification-map.yml';
const packageText = read('package.json');
const testText = read(testFile);
const docText = read(docFile);
const verificationText = read(verificationFile);

for (const scenario of [
  'json_baseline',
  'sse_baseline',
  'target_local_reselection',
  'default_pool_exhaustion',
  'dry_run_no_network',
  'debug_side_channel',
]) {
  if (!testText.includes(scenario)) failures.push(testFile + ': missing scenario marker ' + scenario);
  if (!docText.includes(scenario)) failures.push(docFile + ': missing scenario row ' + scenario);
}

for (const phrase of [
  'env!("CARGO_BIN_EXE_routecodex-v3")',
  'server", "start", "--foreground", "--config"',
  'controlled_responses_upstream',
  'V3Router07OpaqueTargetHitOnce',
  'V3TargetLocalReselected',
  'V3DryRunNoNetworkTerminalEffect',
  'provider_network_send',
  'stopped_before_provider_send',
  'candidates_remaining',
  'write_evidence_artifact',
]) requireText(testFile, phrase);

for (const forbidden of [
  /spawn_v3_server_aggregate/,
  /execute_v3_responses_direct_runtime_kernel/,
  /routecodex_v3_server::/,
  /routecodex_v3_runtime::/,
]) {
  if (forbidden.test(testText)) failures.push(testFile + ': forbidden internal runtime/server entry ' + forbidden);
}

for (const phrase of [
  'feature_id: v3.responses_direct_h2_equivalence_harness',
  'P6 remains the migration source, not the final Hub v1 implementation',
  'CLI-controlled-upstream replay',
  'no H1 Rust symbols',
  'binding_pending',
  'target-local reselection',
  'default pool exhaustion',
  'Debug side-channel',
]) requireText(docFile, phrase);

for (const phrase of [
  'feature_id: v3.responses_direct_h2_equivalence_harness',
  'npm run verify:v3-h2-equivalence-harness',
  'npm run test:v3-h2-equivalence-red-fixtures',
  'npm run test:v3-h2-p6-controlled-replay',
]) requireText(verificationFile, phrase);

for (const scriptName of [
  'verify:v3-h2-equivalence-harness',
  'test:v3-h2-equivalence-red-fixtures',
  'test:v3-h2-p6-controlled-replay',
]) {
  if (!packageText.includes('"' + scriptName + '"')) failures.push('package.json: missing script ' + scriptName);
}

if (failures.length) {
  console.error('[verify:v3-h2-equivalence-harness] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-h2-equivalence-harness] ok');
