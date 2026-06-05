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
  'apply_responses_c4m_request_compat',
  'apply_responses_token_limit_field_normalization(root);',
  'apply_responses_instructions_to_input(root);',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust c4m compat missing required truth: ${required}`);
  }
}

for (const required of [
  'test_req_profile_responses_c4m_native_applied',
  'test_req_profile_responses_c4m_protocol_mismatch_native_noop',
]) {
  if (!reqProfiles.includes(required)) {
    failures.push(`c4m Rust tests missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.c4m_request_compat',
  'npm run verify:responses-c4m-request-compat-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`c4m map binding missing: ${required}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-c4m-request-compat-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-c4m-request-compat-rust-only] ok');
console.log('- checked Rust-only c4m request compat ownership, tests, and map bindings');
