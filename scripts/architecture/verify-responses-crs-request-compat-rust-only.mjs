import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const reqProfiles = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/req_profiles.rs');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'apply_responses_crs_request_compat',
  'normalize_responses_function_tools(root);',
  'root.remove("temperature")',
  'tool_obj.get("function")',
  'normalized_tool.insert("name".to_string()',
  '"parameters".to_string()',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust crs compat missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_crs_normalizes_chat_style_function_tools_for_responses_wire',
  'test_req_profile_responses_crs_strips_temperature',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`crs Rust tests missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.crs_request_compat',
  'npm run verify:responses-crs-request-compat-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`crs map binding missing: ${required}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-crs-request-compat-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-crs-request-compat-rust-only] ok');
console.log('- checked Rust-only crs request compat ownership, tests, and map bindings');
