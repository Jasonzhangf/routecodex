import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustRequestCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/responses/request.rs');
const nativeReqOutboundBridge = read('sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.ts');
const requiredExports = read('sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.ts');
const compatEngine = read('sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'normalize_responses_function_tools',
  'apply_responses_c4m_request_compat',
  'apply_responses_crs_request_compat',
  'root.remove("max_tokens")',
  'root.remove("max_output_tokens")',
  'root.remove("temperature")',
]) {
  if (!rustRequestCompat.includes(required)) {
    failures.push(`rust request compat missing required truth: ${required}`);
  }
}

for (const required of [
  'runReqOutboundStage3CompatJson',
  'runReqOutboundStage3CompatWithNative',
]) {
  if (!nativeReqOutboundBridge.includes(required) && !requiredExports.includes(required) && !compatEngine.includes(required)) {
    failures.push(`native request compat bridge missing: ${required}`);
  }
}

for (const required of [
  'feature_id: responses.request_compat_normalization',
  'npm run verify:responses-request-compat-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`map binding missing request compat feature artifact: ${required}`);
  }
}

const forbiddenRuntimeFiles = [
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/direct-passthrough-payload.ts',
  'src/modules/llmswitch/bridge/native-exports.ts',
];

for (const relPath of forbiddenRuntimeFiles) {
  const source = read(relPath);
  for (const forbidden of [
    'responses:c4m',
    'responses:crs',
    'instructions")',
    'instructions\')',
    'max_output_tokens',
    'maxTokens',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own responses request compat truth: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:responses-request-compat-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:responses-request-compat-rust-only] ok');
console.log('- checked Rust request compat ownership, native bridge wiring, and architecture map bindings');
