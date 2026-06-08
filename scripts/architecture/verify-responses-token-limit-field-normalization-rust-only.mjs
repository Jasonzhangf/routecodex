import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const reqProfiles = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs');
const compatEngine = read('sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts');
const nativeReqOutboundBridge = read('sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'pub(crate) fn apply_responses_token_limit_field_normalization(root: &mut Map<String, Value>)',
  'root.remove("max_tokens");',
  'root.remove("maxTokens");',
  'root.remove("max_output_tokens");',
  'root.remove("maxOutputTokens");',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust token-limit normalization missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_token_limit_fields_are_removed_for_c4m',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`shared Rust token-limit test missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.token_limit_field_normalization',
  'npm run verify:responses-token-limit-field-normalization-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`token-limit map binding missing: ${required}`);
  }
}

if (!compatEngine.includes('feature_id: responses.token_limit_field_normalization')) {
  failures.push('compat-engine missing token-limit normalization feature anchor');
}

if (!nativeReqOutboundBridge.includes('runReqOutboundStage3CompatJson')) {
  failures.push('native req-outbound bridge missing runReqOutboundStage3CompatJson');
}

const forbiddenRuntimeFiles = [
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/direct-passthrough-payload.ts',
  'src/modules/llmswitch/bridge/native-exports.ts',
];

for (const relPath of forbiddenRuntimeFiles) {
  const source = read(relPath);
  for (const forbidden of [
    'root.remove("max_tokens")',
    'root.remove("max_output_tokens")',
    'maxTokens',
    'maxOutputTokens',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses token-limit truth: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-token-limit-field-normalization-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-token-limit-field-normalization-rust-only] ok');
console.log('- checked shared Rust token-limit normalization ownership, bindings, tests, and TS runtime absence');
