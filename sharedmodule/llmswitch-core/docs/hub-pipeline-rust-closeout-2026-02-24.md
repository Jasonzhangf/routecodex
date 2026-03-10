# Hub Pipeline Rust Migration Closeout (2026-02-24)

## Scope
- Epic: `sharedmodule-12`
- Tasks closed in this wave: `sharedmodule-12.1` to `sharedmodule-12.6`
- Current closeout task: `sharedmodule-12.7`

## Matrix Evidence
- Command: `npm run build`
- Result: pass (includes matrix)
- Report: `test-results/llmswitch-core/matrix-ci-1771891640001.json`

## Key Regression/Replays Executed
- Req inbound:
  - `node scripts/tests/coverage-hub-req-inbound-format-parse.mjs`
  - `node scripts/tests/coverage-hub-req-inbound-semantic-lift.mjs`
  - `node scripts/tests/coverage-hub-req-inbound-context-capture-orchestration.mjs`
  - `node scripts/tests/coverage-hub-req-inbound-context-tool-snapshot.mjs`
  - `node scripts/tests/coverage-hub-req-inbound-responses-context-snapshot.mjs`
- Req process:
  - `node scripts/tests/coverage-hub-req-process-route-select.mjs`
  - `node scripts/tests/hub-req-process-route-select-v1-v2-compare.mjs`
- Req outbound:
  - `node scripts/tests/coverage-hub-req-outbound-context-merge.mjs`
  - `node scripts/tests/coverage-hub-req-outbound-format-build.mjs`
  - `node scripts/tests/coverage-hub-req-outbound-compat.mjs`
- Resp inbound:
  - `node scripts/tests/coverage-hub-resp-inbound-sse-stream-sniffer.mjs`
  - `node scripts/tests/coverage-hub-resp-inbound-format-parse.mjs`
  - `node scripts/tests/coverage-hub-resp-inbound-semantic-map.mjs`
- Resp process:
  - `node scripts/tests/coverage-native-chat-process-governance-semantics.mjs`
  - `node scripts/tests/coverage-hub-resp-process-stage2-finalize.mjs`
  - `node scripts/tests/coverage-native-chat-process-servertool-orchestration-semantics.mjs`
  - `node scripts/tests/coverage-hub-chat-process-servertool-orchestration.mjs`
  - `node scripts/tests/servertool-continue-execution-followup.mjs`
- Resp outbound:
  - `node scripts/tests/coverage-hub-resp-outbound-client-semantics.mjs`
  - `node scripts/tests/coverage-hub-resp-outbound-client-remap-protocol-switch.mjs`
  - `node scripts/tests/coverage-hub-resp-outbound-sse-stream.mjs`

## Rust/Bridge Changes in This Iteration
- Added req process stage1 Rust wiring (already landed this wave):
  - `rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
  - `src/router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.ts`
  - `src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts`
- Added resp process stage2 Rust finalize path:
  - `rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`
  - `rust-core/crates/router-hotpath-napi/src/lib.rs`
  - `src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.ts`
  - `src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts`
- Added regression coverage for stage2 finalize:
  - `scripts/tests/coverage-hub-resp-process-stage2-finalize.mjs`
  - `scripts/tests/run-matrix-ci.mjs` (matrix hook)

## Risk List
- `resp_process_stage2_finalize` Rust input fields `stream/endpoint/requestId` are currently parsed but not used for behavior branching.
- Native wrappers intentionally keep fallback paths for compatibility (`fallbackOrThrow`), so strict no-fallback behavior still depends on runtime policy flags.
- Rust crate still has a large number of dead-code warnings; this does not block runtime but increases maintenance noise.

## Conclusion
- Hub Pipeline req/resp stages now run with Rust-backed main paths for the migration scope (`12.1`-`12.6`).
- Full matrix is green and stage-focused regressions are green on this commit line.
