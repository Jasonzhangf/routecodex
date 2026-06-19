import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const rustCompat = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/single_tool_call_history.rs');
const rustStage = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/request_stage.rs');
const rustProfile = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/profile.rs');
const rustTests = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/tests/core.rs');
const functionMap = read('docs/architecture/function-map.yml');
const verificationMap = read('docs/architecture/verification-map.yml');

for (const required of [
  'split_parallel_tool_call_assistant_history',
  'tool_calls.len() <= 1',
  '"tool_calls".to_string()',
]) {
  if (!rustCompat.includes(required)) {
    failures.push(`Rust single-tool-call history compat missing: ${required}`);
  }
}

for (const required of [
  'is_single_tool_call_history_profile',
  'provider_protocol_matches(adapter_context.provider_protocol.as_ref(), "openai-chat")',
  'split_parallel_tool_call_assistant_history(root)',
]) {
  if (!rustStage.includes(required) && !rustProfile.includes(required)) {
    failures.push(`Rust request stage/profile binding missing: ${required}`);
  }
}

for (const required of [
  'openai_chat_single_tool_call_history_profile_splits_parallel_assistant_tool_calls',
  'openai_chat_single_tool_call_history_profile_splits_history_and_latest_parallel_turns',
  'hist_a',
  'latest_c',
  'openai_chat_parallel_assistant_tool_calls_stay_unchanged_without_profile',
  'openai_chat_single_tool_call_history_profile_leaves_single_call_unchanged',
]) {
  if (!rustTests.includes(required)) {
    failures.push(`Rust compat test missing: ${required}`);
  }
}

for (const required of [
  'feature_id: openai_chat.single_tool_call_history_compat',
  'npm run verify:openai-chat-single-tool-call-history-compat-rust-only',
]) {
  if (!functionMap.includes(required) || !verificationMap.includes(required)) {
    failures.push(`map binding missing: ${required}`);
  }
}

const forbiddenRuntimeFiles = [
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/index.ts',
  'src/server/runtime/http-server/executor/provider-request-context.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts',
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts',
];

for (const relPath of forbiddenRuntimeFiles) {
  const source = read(relPath);
  for (const forbidden of [
    'single-tool-call-history',
    'split_parallel_tool_call_assistant_history',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${relPath} must not own openai-chat single-tool-call history compat: ${forbidden}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:openai-chat-single-tool-call-history-compat-rust-only] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:openai-chat-single-tool-call-history-compat-rust-only] ok');
console.log('- checked Rust-only OpenAI chat single-tool-call history compat ownership, tests, and map bindings');
