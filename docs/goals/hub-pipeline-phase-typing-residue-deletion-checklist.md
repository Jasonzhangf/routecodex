# Hub Pipeline Phase Typing Residue Deletion Checklist

## Status

Phase 6C is a boundary-locking phase only. It adds red-test coverage and deletion criteria; it does not delete live stages and does not change runtime behavior, provider wire payload, or client response body.

Request typed wrappers from Phase 6A and response typed wrappers from Phase 6B-2 are live entry boundaries, but the historical Rust stage implementations still carry live business semantics. They remain until a later deletion phase proves the call graph has fully moved behind typed nodes.

## Current Live Implementation — Do Not Delete

These files are still live Rust implementation or current NAPI/engine owners:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage2_route_select.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`

## Current Known Direct-Call Residue — Locked, Not Expanded

Phase 6C red tests lock the current direct-call owner list. New direct calls to these symbols outside the allowed files must fail tests:

- `run_req_process_pipeline`
- `apply_req_process_tool_governance`
- `apply_route_selection`
- `govern_response`
- `finalize_chat_response`
- `build_client_payload_for_protocol`

Known response governance direct-call residue after Phase 7A:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_chatprocess_03_governance_boundary.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/orchestrator.rs`

These remain live owner / implementation points and are not safe deletion targets.

Known response finalize direct-call residue after Phase 7B:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_04_finalize_boundary.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`

These remain live owner / implementation points and are not safe deletion targets.

Known response client payload direct-call residue after Phase 7C:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_04_client_payload_boundary.rs`

This remains the live owner point and is not a safe deletion target.

Known request direct-call residue after Phase 7D:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_chatprocess_03_governance_boundary.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/vr_route_04_selection_boundary.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage2_route_select.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`

These remain live owner / implementation / NAPI bridge points and are not safe deletion targets.

Known legacy NAPI / TS stage bridge residue after Phase 7E:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
  - Defines `run_req_inbound_pipeline`, `run_req_process_pipeline`, and `run_resp_outbound_pipeline`.
  - Still live as Rust stage implementation / legacy stage API source; not safe to delete.
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
  - Owns `runHubPipelineStageJson` bridge and still calls the three legacy Rust stage functions.
  - Still live NAPI bridge; not safe to delete.
Phase 8A-2 red tests lock `runHubPipelineStageWithNative` to the native protocol wrapper only. New TS stage direct callers are forbidden.

## Deleted Proof — Phase 8A-1

Phase 8A-1 physically removed the legacy request process TS shell after call graph migration to the Rust total HubPipeline entry:

- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts`.
- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/README.md`.
- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process.ts`, the only remaining source caller of the stage shell.
- Migrated request-side contract tests that called `runReqProcessStage1ToolGovernance` / `runHubChatProcess` to `runHubPipelineLibWithNative` so tests exercise the Rust total request pipeline instead of the deleted TS stage shell.
- Updated residue red tests so `req_process_stage1_tool_governance/index.ts` and `chat-process.ts` must remain absent, and `runHubPipelineStageWithNative` cannot expand beyond the remaining known shell/wrapper list.

## Deleted Proof — Phase 8A-2

Phase 8A-2 physically removed the final request-side TS stage shell after migrating the live `HubPipeline.execute` caller to Rust total HubPipeline entry:

- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request.ts`.
- Moved request payload materialization into `hub-pipeline.ts` as TS I/O glue only; route selection still happens before Rust total pipeline entry, and normalize semantics are executed by the downstream Rust total request path.
- Migrated the SSE protocol contract test from `normalizeHubPipelineRequest` to `HubPipeline.execute`, proving canonical SSE payloads enter `runHubPipelineLibWithNative`.
- Updated residue red tests so `hub-pipeline-normalize-request.ts` must remain absent, and `runHubPipelineStageWithNative` is allowed only in the native protocol wrapper declarations/implementation.

## Covered By Typed Boundary — Future Delete Candidates

These categories can become deletion candidates only after the required proof gates pass:

- Phase 7A covered response governance callers now enter `hub_resp_chatprocess_03_governance_boundary.rs` instead of importing `govern_response` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/anthropic_openai_codec.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/openai_openai_codec.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/response.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/lmstudio/response.rs`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- Phase 7A renamed the private `hub_tool_governance_semantics.rs` response helper to `govern_tool_name_response`, so it no longer collides with Hub response chatprocess stage naming.
- Phase 7B covered response finalize callers now enter `hub_resp_outbound_04_finalize_boundary.rs` instead of importing `finalize_chat_response` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- Phase 7C covered response outbound client payload projection callers now enter `hub_resp_outbound_04_client_payload_boundary.rs` instead of calling `build_client_payload_for_protocol` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- Phase 7D covered request governance callers now enter `hub_req_chatprocess_03_governance_boundary.rs` instead of calling `apply_req_process_tool_governance` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- Phase 7D covered request route selection callers now enter `vr_route_04_selection_boundary.rs` instead of calling `apply_route_selection` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- Phase 7D leaves `run_req_process_pipeline` at its current Rust/NAPI owner boundary only; no new caller is allowed outside `hub_pipeline.rs` and `hub_pipeline_blocks/napi_bindings.rs`.
- Phase 7E call graph proof: `rg` shows `run_req_inbound_pipeline`, `run_req_process_pipeline`, and `run_resp_outbound_pipeline` are defined in `hub_pipeline.rs`, bridged only by `hub_pipeline_blocks/napi_bindings.rs`, and otherwise referenced by Rust tests. `runHubPipelineStageWithNative` is used by only two TS shell files listed above plus native wrapper/API tests.
- Legacy external direct access to `run_req_process_pipeline` once no NAPI caller or TS shell consumes it outside the total HubPipeline path.
- Legacy direct access to request stage functions once all live request callers enter `HubReqInbound02Standardized -> HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`.
- Legacy direct access to response stage functions once all live response callers enter `HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic`.
- Any remaining TS stage shell, helper, or public export that exposes `req_process` / `resp_process` semantics after typed Rust total pipeline ownership is proven.

## Required Proof Before Deletion

Deletion is allowed only after all evidence is present:

1. Call graph: `rg` proves the candidate has no live imports or calls outside its owning typed wrapper / total engine.
2. Red tests: topology residue tests fail when a forbidden direct import or old API name is reintroduced.
3. Typed wrapper tests: request and response wrapper tests pass.
4. Runtime equivalence: provider wire payload and client response body snapshots remain semantically equivalent.
5. Build: Rust crate build and relevant TypeScript/Jest checks pass.
6. Smoke: global install + explicit port-scoped restart + `/health` confirms runtime after deletion.
7. No fallback: deletion must not introduce fallback, alternate route, or provider-specific patch in Hub Pipeline / Virtual Router.

## Phase 6C Validation Commands

- `npm run jest:run -- --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/red-tests/hub_pipeline_request_typed_entrypoint_contract.test.ts tests/red-tests/hub_pipeline_response_type_topology_contract.test.ts tests/red-tests/hub_pipeline_type_topology_contract.test.ts`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi request_typed_entrypoints --lib`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi response_typed_entrypoints --lib`
- `cargo build --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi`
- `git diff --check`
