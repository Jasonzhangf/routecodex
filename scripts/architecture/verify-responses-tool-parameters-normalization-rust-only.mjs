import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const reqProfiles = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs');
const requiredExports = read('sharedmodule/llmswitch-core/native-hotpath-required-exports.json');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'pub(crate) fn normalize_responses_tool_parameters(raw: Option<&Value>) -> Value',
  'serde_json::from_str::<Value>(text)',
  'fallback.insert("type".to_string(), Value::String("object".to_string()));',
  'fallback.insert("additionalProperties".to_string(), Value::Bool(true));',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust tool-parameters normalization missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_tool_parameters_normalizes_string_json_to_object',
  'test_req_profile_responses_tool_parameters_fallback_to_object_schema',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`shared Rust tool-parameters test missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.tool_parameters_normalization',
  'npm run verify:responses-tool-parameters-normalization-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`tool-parameters map binding missing: ${required}`);
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
    'serde_json::from_str::<Value>',
    'additionalProperties',
    'normalize_responses_tool_parameters',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses tool-parameters normalization truth: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-tool-parameters-normalization-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-tool-parameters-normalization-rust-only] ok');
console.log('- checked shared Rust tool-parameters normalization ownership, bindings, tests, and TS runtime absence');
