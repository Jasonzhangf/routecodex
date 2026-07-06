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
const pkgJson = JSON.parse(pkg);
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

function sectionFor(text, featureId) {
  const start = text.indexOf(`feature_id: ${featureId}`);
  if (start < 0) {
    return '';
  }
  const rest = text.slice(start + featureId.length);
  const next = rest.search(/\n\s*-\s+feature_id:\s+/);
  return text.slice(start, next < 0 ? text.length : start + featureId.length + next);
}

function functionBody(text, functionName) {
  const marker = `pub fn ${functionName}`;
  const start = text.indexOf(marker);
  if (start < 0) {
    return '';
  }
  const next = text.indexOf('\n#[', start + marker.length);
  return text.slice(start, next < 0 ? text.length : next);
}

const responsesContinuationFeature = 'hub.chat_process_responses_continuation';
const responsesContinuationFunctionMap = sectionFor(functionMap, responsesContinuationFeature);
const responsesContinuationVerificationMap = sectionFor(verificationMap, responsesContinuationFeature);
const publishRecordPlanBody = functionBody(rustStore, 'publish_responses_record_plan_json');

for (const required of [
  'normalize_responses_tool_definition',
  'normalize_responses_history_item',
  'normalize_responses_history_items',
  'prepare_persists_responses_legal_tools_and_history_items',
  'restore_never_emits_function_call_output_content_from_persisted_history',
  'materialize_plain_continuation_keeps_persisted_prefix_semantics_and_applies_current_delta_fields_only',
  'publish_responses_record_plan_uses_current_request_id_before_stale_request_truth',
  'let current_request_id = request_id.trim();',
]) {
  if (!rustStore.includes(required)) {
    failures.push(`responses history protocol owner missing required anchor: ${required}`);
  }
}

for (const forbidden of [
  'strip_meta_from_history_items',
  'out.insert("function".to_string()',
  'out.insert("role".to_string(), Value::String("assistant".to_string()))',
  'publish_responses_record_plan_uses_request_truth_request_id',
  'publish_responses_record_plan_uses_request_truth_over_client_response_request_id',
]) {
  if (rustStore.includes(forbidden)) {
    failures.push(`responses history must not revive illegal persisted shape path: ${forbidden}`);
  }
}

if (!pkg.includes('verify:responses-history-protocol-contract')) {
  failures.push('package build gate must include verify:responses-history-protocol-contract');
}

if (!pkgJson.scripts?.['build:base']?.includes('npm run verify:responses-history-protocol-contract')) {
  failures.push('build:base must run verify:responses-history-protocol-contract before build artifacts are produced');
}

for (const [name, section] of [
  ['function-map', responsesContinuationFunctionMap],
  ['verification-map', responsesContinuationVerificationMap],
]) {
  if (!section) {
    failures.push(`${name} missing ${responsesContinuationFeature}`);
    continue;
  }
  if (!section.includes('npm run verify:responses-history-protocol-contract')) {
    failures.push(`${name} ${responsesContinuationFeature} must list verify:responses-history-protocol-contract`);
  }
  if (!section.includes('current active provider request label')) {
    failures.push(`${name} ${responsesContinuationFeature} must document active provider request label priority`);
  }
}

if (!publishRecordPlanBody) {
  failures.push('publish_responses_record_plan_json function body not found');
} else if (!/let\s+entry_request_id\s*=\s*if\s+!current_request_id\.is_empty\(\)\s*\{\s*current_request_id\.to_string\(\)\s*\}\s*else\s*\{[\s\S]*read_request_truth_field\(&context,\s*"requestId"\)/.test(publishRecordPlanBody)) {
  failures.push('publish_responses_record_plan_json must choose current request_id before requestTruth.requestId');
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
