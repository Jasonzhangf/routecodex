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
  'fn normalize_responses_function_tools(root: &mut Map<String, Value>)',
  'tool_obj.get("function")',
  'normalized_tool.insert("name".to_string()',
  '"parameters".to_string()',
  'normalize_responses_tool_parameters(',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust function-tool normalization missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_crs_normalizes_chat_style_function_tools_for_responses_wire',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`shared Rust normalization test missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.function_tool_normalization',
  'npm run verify:responses-function-tool-normalization-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`shared normalization map binding missing: ${required}`);
  }
}

if (!compatEngine.includes('feature_id: responses.function_tool_normalization')) {
  failures.push('compat-engine missing shared function tool normalization feature anchor');
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
    'tool_obj.get("function")',
    'normalized_tool.insert("name"',
    'normalize_responses_function_tools',
    'chat-style function tool',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses function-tool normalization truth: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-function-tool-normalization-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-function-tool-normalization-rust-only] ok');
console.log('- checked shared Rust tool normalization ownership, bindings, tests, and TS runtime absence');
