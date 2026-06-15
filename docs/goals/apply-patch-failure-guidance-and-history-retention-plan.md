# apply_patch Failure Guidance and History Retention Plan

## Goal

Close `apply_patch` failure recovery so failed calls return executable correction guidance and retry history keeps paired tool calls and outputs.

## Owner

- Feature: `tool.apply_patch_freeform_contract`
- Owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
- Allowed implementation paths: Rust owner only.
- Forbidden implementation paths: `src/providers/core/runtime`, `src/server/runtime/http-server`, `src/providers/profile`.

## Required Semantics

- Failed apply_patch output must normalize to deterministic `APPLY_PATCH_ERROR:` guidance.
- Guidance must tell model to retry with `apply_patch` only, send one raw `patch` string, use `*** Begin Patch` / `*** End Patch`, and use workspace-relative patch headers.
- Success output must normalize to deterministic `APPLY_PATCH_RESULT:` guidance.
- Missing patch, empty patch, malformed patch, synthetic guard patch, and bad retry payload must stay tool failure, not ordinary text or shell fallback.
- Tool history must preserve ordered `apply_patch` call/output pairs across retry, including interleaved `exec_command` calls.

## Red Tests

- Empty or missing apply_patch arguments produce guard/corrective failure, not shell/exec fallback.
- Failed apply_patch output is normalized to `APPLY_PATCH_ERROR` and keeps `apply_patch`-only retry guidance.
- Synthetic `__APPLY_PATCH_ERROR__` guard history is retained as a failure output instead of pruning the call/output pair.
- Reopened apply_patch after `exec_command` keeps all tool call ids and outputs ordered.

## Fix Plan

1. Add red tests in Rust owner tests and existing apply_patch contract tests.
2. If red proves gap, patch only Rust owner:
   - `hub_req_inbound_tool_call_normalization.rs`
   - `hub_req_inbound_context_capture.rs`
   - `resp_process_stage1_tool_governance_blocks/apply_patch_guard.rs`
   - `resp_process_stage1_tool_governance_blocks/apply_patch_schema_args.rs`
3. Keep function map unchanged unless source anchors/gates need tightening.
4. Run required gates and sample replay.

## Verification

- `npm run verify:apply-patch-freeform-contract`
- `npm run verify:apply-patch-regressions`
- `npm run verify:function-map-compile-gate`
- focused `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture`
- 5555 old sample replay or reconstructed sample replay
- 5520 directed replay or live failure/retry probe

## Done

Done only when failed apply_patch shows corrective guidance, next turn keeps full apply_patch tool history, empty patch remains explicit tool failure, and required gates plus 5555/5520 replay pass.
