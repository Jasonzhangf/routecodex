#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relativePath, alternatives = []) {
  const candidates = [relativePath, ...alternatives];
  const existing = candidates
    .map((candidate) => path.join(root, candidate))
    .find((candidate) => fs.existsSync(candidate));
  const file = existing ?? path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    failures.push(`${candidates.join(' | ')}: missing full-attempt lifecycle source`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

const manifest = read('docs/architecture/mainline-manifests/v3.direct_sse_accept_skeleton.mainline.yml', [
  'docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml',
  '../docs/architecture/mainline-manifests/v3.direct_sse_accept_skeleton.mainline.yml',
  '../docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml',
  '../../docs/architecture/mainline-manifests/v3.direct_sse_accept_skeleton.mainline.yml',
  '../../docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml',
]);
const design = read('docs/goals/v3-responses-direct-precommit-sse-failure-test-design.md', [
  '../docs/goals/v3-responses-direct-precommit-sse-failure-test-design.md',
  '../../docs/goals/v3-responses-direct-precommit-sse-failure-test-design.md',
]);
const runtime = read('crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs');
const directCore = read('crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs');
const tests = read('crates/routecodex-v3-runtime/tests/support/kernel_unit.rs');
const resourceMap = read('docs/architecture/v3-resource-operation-map.yml', ['../docs/architecture/v3-resource-operation-map.yml']);
const functionMap = read('docs/architecture/v3-function-map.yml', ['../docs/architecture/v3-function-map.yml']);
const mainlineMap = read('docs/architecture/v3-mainline-call-map.yml', ['../docs/architecture/v3-mainline-call-map.yml']);

for (const [name, source, markers] of [
  ['manifest', manifest, [
    'commit_contract_owner_feature_id: v3.responses_direct_full_attempt_commit',
    'client_semantic_commit: forbidden until one provider attempt has a complete',
    'attempt_buffer:',
    'replacement_success:',
    'candidate_exhaustion:',
    'verify:v3-direct-sse-full-attempt-commit',
  ]],
  ['design', design, [
    'buffer the complete provider attempt',
    'failed attempt\'s buffered frames must never be concatenated',
    'no partial provider bytes may reach the client',
  ]],
  ['runtime', runtime, [
    'V3DirectSseAttemptBuffer',
    'V3DirectSseAttemptTerminal',
    'full attempt must reach a protocol terminal before client commit',
  ]],
  ['direct core', directCore, [
    'commit_direct_sse_attempt_after_terminal',
  ]],
  ['tests', tests, [
    'direct_sse_full_attempt_commit_reselects_after_partial_network_failure',
    'direct_sse_full_attempt_commit_rejects_eof_without_terminal',
    'direct_sse_full_attempt_commit_does_not_mix_failed_attempt_bytes',
  ]],
  ['resource map', resourceMap, [
    'v3.sse.direct.full_attempt_buffer',
    'owner_feature_id: v3.responses_direct_full_attempt_commit',
    'owner_node: V3DirectSseAttemptBuffer',
  ]],
  ['function map', functionMap, [
    'feature_id: v3.responses_direct_full_attempt_commit',
    'V3DirectSseAttemptBuffer',
    'commit_direct_sse_attempt_after_terminal',
  ]],
  ['mainline map', mainlineMap, [
    'chain_id: v3.responses_direct_full_attempt_commit',
    'v3-direct-sse-full-attempt-buffer',
    'v3-direct-sse-full-attempt-terminal-commit',
  ]],
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) failures.push(`${name}: missing ${marker}`);
  }
}

for (const [name, source, forbidden] of [
  ['runtime', runtime, [
    'without waiting for provider EOF',
    '(!state.semantic_item_admitted).then',
  ]],
  ['direct core', directCore, [
    'commit_direct_sse_stream(stream)',
  ]],
]) {
  for (const marker of forbidden) {
    if (source.includes(marker)) failures.push(`${name}: forbidden pre-full-attempt marker ${marker}`);
  }
}

if (failures.length) {
  console.error('[verify:v3-direct-sse-full-attempt-commit] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-direct-sse-full-attempt-commit] ok');
