import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustStore = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs');
const pkg = read('package.json');

for (const required of [
  'normalize_responses_tool_definition',
  'normalize_responses_history_item',
  'normalize_responses_history_items',
  'prepare_persists_responses_legal_tools_and_history_items',
  'restore_never_emits_function_call_output_content_from_persisted_history',
  'materialize_plain_continuation_keeps_persisted_prefix_semantics_and_applies_current_delta_fields_only',
]) {
  if (!rustStore.includes(required)) {
    failures.push(`responses history protocol owner missing required anchor: ${required}`);
  }
}

for (const forbidden of [
  'strip_meta_from_history_items',
  'out.insert("function".to_string()',
  'out.insert("role".to_string(), Value::String("assistant".to_string()))',
]) {
  if (rustStore.includes(forbidden)) {
    failures.push(`responses history must not revive illegal persisted shape path: ${forbidden}`);
  }
}

if (!pkg.includes('verify:responses-history-protocol-contract')) {
  failures.push('package build gate must include verify:responses-history-protocol-contract');
}

if (failures.length === 0) {
  const result = spawnSync('cargo', [
    'test',
    '-p',
    'router-hotpath-napi',
    'shared_responses_conversation',
    '--manifest-path',
    'sharedmodule/llmswitch-core/rust-core/Cargo.toml',
  ], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failures.push(`cargo shared_responses_conversation tests failed with status ${result.status}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-history-protocol-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-history-protocol-contract] ok');
console.log('- checked Rust Responses conversation history protocol anchors and cargo regression tests');
