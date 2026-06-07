# Hub Pipeline Phase Typing Residue Deletion Checklist

## Status

Phase 6C is a boundary-locking phase only. It adds red-test coverage and deletion criteria; it does not delete live stages and does not change runtime behavior, provider wire payload, or client response body.

No safe live-path deletion in this phase.

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

Phase 8B-2 call graph proof: `run_resp_outbound_pipeline` and `run_resp_outbound_pipeline_json` remain referenced only by the legacy Rust stage implementation / NAPI bridge owner pair:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
  - Defines `run_resp_outbound_pipeline` and re-exports `run_resp_outbound_pipeline_json` from the bridge module.
  - Still live as the Rust legacy stage API source; not safe to delete during Phase 8B-2.
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
  - Owns `run_resp_outbound_pipeline_json` and is the only current bridge caller of `run_resp_outbound_pipeline`.
  - Still live as `runHubPipelineStageJson` bridge owner; not safe to delete until the legacy stage API has no external stage wrapper consumer.

Phase 8B-2 red tests now lock `run_resp_outbound_pipeline` and `run_resp_outbound_pipeline_json` to those owner files only. New response outbound legacy stage bridge callers are forbidden.

Phase 8B-3 review proof: `runHubPipelineStageWithNative` remains live only in `native-hub-pipeline-orchestration-semantics-protocol.ts` / `.d.ts` / generated `.js` and the API contract test; `runHubPipelineStageJson` remains required as the Rust NAPI capability string / export. Live request/response mainlines use `runHubPipelineLibWithNative` / `executeHubPipelineWithNative`, not the stage wrapper.

- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-lib.js` is a local untracked generated barrel in this worktree, not a committed deletion target for Phase 8B-3.
- No tracked TS/JS/d.ts source imports `native-hub-pipeline-lib`; red tests now forbid making that barrel a live import surface.
- Red tests continue to lock `runHubPipelineStageWithNative` source consumers to the native protocol wrapper declarations/implementation only.

Deletion condition for remaining stage wrapper/export: do not delete `runHubPipelineStageWithNative` / `runHubPipelineStageJson` until the legacy stage API contract test and required native export list are retired together. Live mainline must stay on `executeHubPipelineWithNative` / `runHubPipelineLibWithNative` typed/total boundary.

Phase 8C-1 required-export review proof: `runHubPipelineStageJson` is still consumed by the native hotpath required-export loader as part of `REQUIRED_NATIVE_HOTPATH_EXPORTS`; this is a load-time availability gate, not a live business mainline caller. The only source-level business wrapper that names it remains `runHubPipelineStageWithNative` in `native-hub-pipeline-orchestration-semantics-protocol.ts`, and the only test caller is the API contract test.

- Do not delete `runHubPipelineStageJson` from `native-router-hotpath-required-exports.ts` while `runHubPipelineStageWithNative` and `hub-pipeline-rust-lib-api-contract.spec.ts` still assert the legacy stage wrapper contract.
- New runtime consumers of `runHubPipelineStageJson` are forbidden; red tests now allow the string only in the native protocol wrapper and required-export declaration/generated files.
- Required-export tests now document that `runHubPipelineStageJson` is retained only alongside `runHubPipelineLibJson` / `executeHubPipelineJson` until the wrapper contract is retired.

Phase 8C-2 Rust NAPI owner proof: Rust `#[napi(js_name = "runHubPipelineStageJson")]` is locked to `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`; the only Rust wrapper call to `hub_pipeline_lib::run_hub_pipeline_stage_json(...)` is that NAPI export wrapper. The legacy implementation remains live in `hub_pipeline_lib/engine.rs`, with `hub_pipeline_lib/mod.rs` only re-exporting it for the existing NAPI wrapper; do not add new Rust call sites.

- Red tests now forbid additional Rust NAPI exports or Rust call sites for `run_hub_pipeline_stage_json` outside `lib.rs` / `hub_pipeline_lib/engine.rs` / `hub_pipeline_lib/mod.rs`.
- Exit condition remains paired with Phase 8C-1: remove Rust NAPI export, TS wrapper contract, and required-export entry together only after no legacy stage API contract remains.

Phase 8C-3 legacy branch proof: `run_hub_pipeline_stage_json` currently has exactly three stage-only branches in `hub_pipeline_lib/engine.rs`: `normalizeRequest`, `reqProcessToolGovernance`, and `respProcessFinalize`. These are retirement-list branches for the legacy stage wrapper only; live mainline must continue through `execute_hub_pipeline_json` / `run_hub_pipeline_lib_json`.

- Red tests now forbid adding new legacy stage names or branch helpers under `run_hub_pipeline_stage_json`.
- Red tests also forbid wiring request-process or response-outbound legacy JSON stage APIs into `hub_pipeline_lib/engine.rs` as new stage-only branch targets.
- Exit condition: delete these branches together with the legacy `runHubPipelineStageJson` wrapper/export after the wrapper contract is retired; do not add replacement branch names.

Phase 8D-1 request-side bridge proof: `run_req_inbound_pipeline`, `run_req_inbound_pipeline_json`, `run_req_process_pipeline`, and `run_req_process_pipeline_json` remain locked to the legacy Rust stage implementation / NAPI bridge owner pair only: `hub_pipeline.rs` and `hub_pipeline_blocks/napi_bindings.rs`. Rust tests may exercise the implementation, but no production Rust module may add a direct caller outside that owner pair.

- Red tests now forbid adding request-side legacy stage bridge direct callers outside the owner pair.
- Exit condition: delete these request-side bridge symbols only together with the legacy `runHubPipelineStageJson` wrapper/export after the stage API contract is retired; live mainline must stay on `run_hub_pipeline_lib_json` / `execute_hub_pipeline_json`.

Phase 8D-2 response-side bridge proof: `run_resp_outbound_pipeline` and `run_resp_outbound_pipeline_json` remain locked to the legacy Rust stage implementation / NAPI bridge owner pair only: `hub_pipeline.rs` and `hub_pipeline_blocks/napi_bindings.rs`. Rust tests may exercise the implementation, but no production Rust module may add a direct caller outside that owner pair.

- Red tests now forbid adding response-side legacy stage bridge direct callers outside the owner pair.
- Exit condition: delete these response-side bridge symbols only together with the legacy `runHubPipelineStageJson` wrapper/export after the stage API contract is retired; live response mainline must stay on `execute_hub_pipeline_json` / typed response boundaries.

Phase 8E-1 stage wrapper deletion-blocker proof: tracked source consumers of `runHubPipelineStageWithNative` are now locked to the native protocol wrapper plus contract/red-test files only; tracked source consumers of `runHubPipelineStageJson` are locked to the Rust NAPI export, native protocol wrapper, required-export list, and contract/red-test files only. This proves the remaining blocker is the explicit wrapper contract / required-export gate, not live mainline usage.

- Red tests now forbid adding new tracked source consumers of `runHubPipelineStageWithNative` or `runHubPipelineStageJson` outside that blocker set.
- Exit condition: retire the API contract test expectation, required-export entry, native wrapper export, Rust NAPI wrapper, and Rust stage implementation together after a separate deletion phase proves no wrapper contract remains.

Phase 8E-2 deletion proof: the explicit wrapper contract / required-export gate was the final blocker, and it has been retired as a single group. `runHubPipelineStageWithNative`, `runHubPipelineStageJson`, the Rust NAPI wrapper, the Rust `run_hub_pipeline_stage_json` implementation, and its three stage-only helpers (`normalizeRequest`, `reqProcessToolGovernance`, `respProcessFinalize`) were physically removed together.

- Contract tests now assert only the total Rust HubPipeline entries (`runHubPipelineLibJson` / `executeHubPipelineJson`) and required exports must not include `runHubPipelineStageJson`.
- Red tests now fail if the legacy TS wrapper, required export, Rust NAPI wrapper, Rust stage implementation, or stage-only helper names are reintroduced.
- Live mainline remains on `runHubPipelineLibWithNative` / `executeHubPipelineWithNative`; provider wire and client response body semantics were not changed by this deletion.

Phase 8F-1 generated source-map deletion proof: all tracked `sharedmodule/llmswitch-core/src/**/*.js.map` files were physically removed. `.gitignore` already treats src-side `.js`, `.d.ts`, and `.js.map` as generated TS emit; no tracked `.js` or `.d.ts` files exist under that tree, and no runtime source imports `.js.map` artifacts.

- Red test now fails if any worktree-existing `sharedmodule/llmswitch-core/src/**/*.js.map` file is tracked.
- This deletion touches generated debug artifacts only; `.ts` source, native wrapper imports, provider wire payload, and client response semantics are unchanged.
- Local ignored side-by-side `.js` files may still exist after builds and must not be treated as source truth or committed.

Phase 8F-2 zero-consumer TS wrapper deletion proof: 9 old TS native-wrapper/helper files had no live source/test consumers, no public `conversion/index.ts` export, no same-name ignored JS shadow artifacts, and their native capabilities remain available from Rust/native wrapper truth. These files were physically removed:

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-mutable-record-utils.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/target-utils.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-governance-finalize.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search-intent.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search-tool-schema.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/client-inject-readiness.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/chat-response-utils.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-observation.ts`

Red test now fails if any of these zero-consumer TS wrapper residues reappear. This deletion does not remove the Rust/native capabilities themselves and does not change provider wire payload or client response semantics.

Phase 8F-3 timing wrapper deletion proof: `hub-stage-timing-measure-blocks.ts` had no live consumer and duplicated the private `measureHubStageExecution` implementation already present in `hub-stage-timing.ts`. The tracked TS file and ignored side-by-side `.js` / `.d.ts` / `.js.map` artifacts were physically removed.

- Red test now fails if the timing measure block TS source or same-name generated artifacts reappear.
- This deletion keeps `hub-stage-timing.ts` as the single timing measure owner and does not affect Hub payload semantics.

Phase 8F-4 virtual router bootstrap helper deletion proof: five legacy TS bootstrap helper files had no live source/test import, no public barrel export, and no same-name generated shadow artifacts. Their responsibilities are already owned by native bootstrap entries (`bootstrapVirtualRouterProvidersJson`, `bootstrapVirtualRouterProviderProfilesJson`, `bootstrapVirtualRouterConfigMetaJson`), Rust `virtual_router_engine/provider_bootstrap.rs`, and the active auth token scanner under `src/providers/auth/token-scanner/`.

- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/auth-utils.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/claude-code-helpers.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/config-normalizers.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap/web-search-config.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/token-file-scanner.ts`.
- Red test now fails if any of these legacy bootstrap helper residues reappear.

Phase 8F-5 virtual router engine helper deletion proof: two TS engine helper files had no live source/test import and no same-name generated shadow artifacts. Their routing-state and selection semantics now live in Rust Virtual Router/native routing owners; `VirtualRouterEngine` does not import these helpers.

- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine/route-analytics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/metadata.ts`.
- Red test now fails if either legacy engine helper residue reappears.

Phase 8F-6 unused native wrapper deletion proof: six TS native wrapper files had no live source/test import and no dynamic bridge importer. The native capabilities they referenced remain locked by `native-router-hotpath-required-exports.ts`; the live request filter wrapper is `native-chat-request-filter-semantics.ts`, not the deleted governed-filter residue.

- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governed-filter-semantics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-post-governed-normalization-semantics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-web-search-intent-semantics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-governance-semantics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-target-semantics.ts`.
- Deleted `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-virtual-router-stop-message-actions-semantics.ts` plus same-name generated `.js` / `.d.ts` / `.js.map` artifacts.
- Kept `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-failure-policy.ts` because it is dynamically loaded by `src/modules/llmswitch/bridge/native-exports.ts` and `src/providers/core/runtime/provider-failure-policy-native.ts`.
- Red test now fails if any deleted unused wrapper residue reappears.

Phase 8F-7 Hub/VR side-by-side emit cleanup proof: current `sharedmodule/llmswitch-core/tsconfig.json` emits to `dist`, and `.gitignore` marks `sharedmodule/llmswitch-core/src/**/*.js`, `.d.ts`, and `.js.map` as generated artifacts. Therefore side-by-side emit files under Hub Pipeline and Virtual Router source truth dirs are stale local artifacts, not runtime source truth.

- Deleted 193 ignored generated artifacts under `sharedmodule/llmswitch-core/src/conversion/hub` and `sharedmodule/llmswitch-core/src/router/virtual-router`.
- Deletion script refused non-ignored candidates before unlinking; only git-ignored `.js`, `.d.ts`, and `.js.map` files were removed.
- Red test now fails if either source truth dir contains side-by-side `.js`, `.d.ts`, or `.js.map` artifacts.
- This cleanup changes no tracked runtime source and does not change provider wire payload or client response semantics.

Phase 8F-8 servertool side-by-side emit cleanup proof: servertool source truth lives in `.ts` plus Rust `servertool-core/servertool-cli` owners; source-side `.d.ts` artifacts under `sharedmodule/llmswitch-core/src/servertool` are stale ignored emit, not runtime source truth.

- Deleted 26 ignored generated declaration artifacts under `sharedmodule/llmswitch-core/src/servertool`.
- Deletion script refused non-ignored candidates before unlinking; only git-ignored `.js`, `.d.ts`, and `.js.map` files were eligible.
- Red test now fails if `sharedmodule/llmswitch-core/src/servertool` contains side-by-side `.js`, `.d.ts`, or `.js.map` artifacts.
- This cleanup changes no tracked runtime source and does not change servertool projection, provider wire payload, or client response semantics.

Phase 8F-9 legacy shared Responses request adapter deletion proof: `sharedmodule/llmswitch-core/src/conversion/shared/responses-request-adapter.ts` was a zero-consumer thin adapter that re-exported `captureResponsesContext` / `buildChatRequestFromResponses` from the live bridge while adding only a native capability probe. Live source and tests call `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts` directly.

- Deleted `sharedmodule/llmswitch-core/src/conversion/shared/responses-request-adapter.ts`.
- No same-name `.js`, `.d.ts`, or `.js.map` artifacts existed before deletion.
- Updated `sharedmodule/llmswitch-core/src/guidance/RCC_TOOL_GUIDE.md` so active guidance points to the bridge owner and forbids restoring the shared adapter middle layer.
- Red test now fails if the adapter source or active guide mention reappears.

Phase 8F-10 additional Hub zero-consumer source deletion proof: import graph and symbol scan showed three Hub source files had no live source/test/script importer, no public barrel export, and no same-name generated runtime shadow. The related native capabilities remain in native wrapper truth; the live Hub envelope type owner is `types/chat-envelope.ts`.

- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/ops/operations.ts`.
- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/tool-session-compat.ts`.
- Deleted `sharedmodule/llmswitch-core/src/conversion/hub/types/chat-schema.ts`.
- Kept `sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts` because it is dynamically loaded by `src/modules/llmswitch/bridge/snapshot-recorder.ts` via `importCoreDist('conversion/hub/snapshot-recorder')`.
- Kept `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-failure-policy.ts` because it is dynamically loaded by bridge/runtime failure-policy owners.
- Updated `docs/goals/metadata-request-isolation-plan.md` so it points to live `chat-envelope.ts` and records that `chat-schema.ts` must not be restored.
- Red test now fails if any deleted source file reappears.

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
- Phase 8B-1 covered response codec finalize caller now enters `hub_resp_outbound_04_finalize_boundary.rs` instead of calling `finalize_chat_response_json` directly:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/openai_openai_codec.rs`
  - `finalize_chat_response` and `finalize_chat_response_json` are now red-test locked to their owner implementation file / typed boundary only.
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
