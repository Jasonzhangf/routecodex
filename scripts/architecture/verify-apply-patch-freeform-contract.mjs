import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function requireIncludes(relPath, expected, label = expected) {
  const text = read(relPath);
  if (!text.includes(expected)) {
    failures.push(`${relPath} missing: ${label}`);
  }
}

function requireExcludes(relPath, unexpected, label = unexpected) {
  const text = read(relPath);
  if (text.includes(unexpected)) {
    failures.push(`${relPath} still contains forbidden legacy text: ${label}`);
  }
}

requireIncludes(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs',
  'serde_json::json!(["patch"])',
  'apply_patch parameters required must collapse to patch-only'
);
requireIncludes(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs',
  'Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string.',
  'Anthropic outbound apply_patch must carry canonical freeform patch guidance'
);
requireIncludes(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs',
  'Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar.',
  'inbound apply_patch retry text must use raw patch grammar'
);
requireIncludes(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/apply_patch_guard.rs',
  'resend one raw patch string in canonical *** Begin Patch / *** End Patch grammar.',
  'response-side apply_patch guard must use raw patch grammar'
);
requireIncludes(
  'sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch.ts',
  'apply_patch requires a workspace-relative path inside the patch header.',
  'servertool apply_patch must instruct patch-header path'
);
requireIncludes(
  'sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch.ts',
  'Retry with apply_patch only. Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar.',
  'servertool apply_patch retry guidance must be freeform-only'
);
requireExcludes(
  'sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch.ts',
  'Retry with workspace-relative filePath. Create file:',
  'legacy filePath+patch retry example'
);
requireIncludes(
  'sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs',
  'freeform-only tool schema regression passed',
  'sharedmodule apply_patch freeform regression script must exist'
);
requireIncludes(
  'scripts/tests/ci-jest.mjs',
  'tests/sharedmodule/apply-patch-chat-process-contract.spec.ts',
  'ci-jest must include apply_patch contract suite'
);

if (failures.length > 0) {
  console.error('[verify:apply-patch-freeform-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:apply-patch-freeform-contract] ok');
console.log('- checked Rust/TS apply_patch freeform contract anchors and CI coverage wiring');
