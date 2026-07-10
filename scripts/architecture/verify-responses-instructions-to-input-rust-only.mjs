import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const reqProfiles = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs');
const requiredExports = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'pub(crate) fn apply_responses_instructions_to_input(root: &mut Map<String, Value>)',
  '.remove("instructions")',
  'strip_html_tags(&raw_text)',
  'resolve_compat_instruction_max_len()',
  'input_array.insert(0, Value::Object(message));',
  'message.insert("role".to_string(), Value::String("system".to_string()));',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust instructions-to-input normalization missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_instructions_to_input_trims_html_and_lifts_system_message',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`shared Rust instructions test missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.instructions_to_input_normalization',
  'npm run verify:responses-instructions-to-input-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`instructions-to-input map binding missing: ${required}`);
  }
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts'))) {
  failures.push('compat-engine TS runtime shell must stay physically deleted');
}

if (!requiredExports.includes('runReqOutboundStage3CompatJson')) {
  failures.push('native required exports missing runReqOutboundStage3CompatJson');
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts'))) {
  failures.push('native-hub-pipeline-req-outbound-semantics TS wrapper must stay physically deleted');
}

const forbiddenRuntimeFiles = [
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/direct-passthrough-payload.ts',
  'src/modules/llmswitch/bridge/native-exports.ts',
];

for (const relPath of forbiddenRuntimeFiles) {
  const source = read(relPath);
  for (const forbidden of [
    'strip_html_tags',
    'resolve_compat_instruction_max_len',
    'input_array.insert(0, Value::Object(message))',
    '.remove("instructions")',
    'role".to_string(), Value::String("system".to_string())',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses instructions-to-input truth: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-instructions-to-input-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-instructions-to-input-rust-only] ok');
console.log('- checked shared Rust instructions-to-input ownership, bindings, tests, and TS runtime absence');
