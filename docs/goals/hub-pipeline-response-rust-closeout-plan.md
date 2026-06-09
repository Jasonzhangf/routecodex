# Hub Pipeline Response Rust Closeout Plan

## Objective

Close the response-side Hub Pipeline Rust migration so live response semantics are owned by Rust:

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
```

TypeScript may remain only for IO glue, native invocation, type declarations, HTTP/SSE frame writing, and runtime lifecycle wiring. It must not own response parsing, tool governance, servertool decisions, client protocol projection, metadata/debug stripping, provider-specific repair, or fallback behavior.

## Acceptance Criteria

- Response-side live semantic owners are Rust files under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`.
- TS response files are classified as one of: native wrapper, IO glue, type-only, or deletion candidate.
- Any TS response semantic residue is either physically deleted or moved to the matching Rust owner.
- Gates prevent reintroducing TS response semantic owners, old stage shells, metadata/debug leaks, provider-specific Hub fixes, and fallback/sanitizer paths.
- Function map and verification map identify owner modules and required tests for the response chain.
- Focused response tests, Rust tests, shadow tests, TypeScript check, and architecture/servertool gates pass or unrelated failures are explicitly isolated with evidence.

## Scope

### In Scope

- `sharedmodule/llmswitch-core/src/conversion/hub/response/*`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts` response path
- `sharedmodule/llmswitch-core/src/conversion/shared/*` only when called by the live response path
- Rust response owners:
  - `hub_resp_inbound_format_parse.rs`
  - `hub_resp_chatprocess_03_governance_boundary.rs`
  - `hub_resp_outbound_client_semantics.rs`
  - `hub_resp_outbound_client_semantics_blocks/*`
  - `hub_resp_outbound_04_client_payload_boundary.rs`
  - `hub_resp_outbound_04_finalize_boundary.rs`
  - `hub_pipeline_types/response_typed_entrypoints.rs`
  - `hub_pipeline_contracts/mod.rs`

### Out of Scope

- Request-side closeout except where a response file directly depends on request-side residue.
- Direct/provider-direct passthrough behavior.
- Virtual Router selection, health, quota, forwarder scheduling, provider transport timeouts.
- Unrelated dirty work in provider runtime, direct path, VR diagnostics, package metadata, or generated build info.

## Design Rules

- No fallback, downgrade, silent sanitizer, payload semantic trimming, or auto-repair in TS.
- No provider-specific branch in Hub Pipeline or Virtual Router response owners.
- Metadata/debug/snapshot/error carrier must not enter client response body.
- Errors must enter explicit error handling; response code must not convert failures into successful payloads.
- Only adjacent response-chain conversions are allowed.
- Old names such as `resp_process` may exist only as legacy Rust owner names where already locked; do not create new old-name API or TS shell.

## Execution Plan

1. Inventory live response imports and call graph.
2. Classify every response-side TS file:
   - native wrapper
   - IO glue
   - type-only
   - semantic residue
   - zero-consumer deletion candidate
3. Write or update a residue gate before deleting or moving code.
4. Move semantic residue to the existing Rust response owner, or call existing native owner directly.
5. Delete zero-consumer TS wrappers and generated/source-side residue after proving no live import.
6. Update docs:
   - this plan
   - `docs/architecture/function-map.yml`
   - `docs/architecture/verification-map.yml`
   - `.agents/skills/rcc-dev-skills/SKILL.md` only for new reusable rules
7. Review the diff for fallback, duplicated owner, provider-specific Hub logic, payload trimming, metadata leak, and old TS semantic revival.
8. Commit only this response-closeout slice.

## Verification Matrix

Minimum verification:

- `npm run verify:servertool-rust-only`
- `npm run verify:architecture-ci`
- `npm run test:unified-hub-shadow`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `cargo test -p router-hotpath-napi hub_resp --lib -- --nocapture`
- `cargo test -p router-hotpath-napi resp_process --lib -- --nocapture`
- `cargo test -p router-hotpath-napi hub_pipeline_contracts --lib -- --nocapture`
- Focused Jest/script tests covering changed response paths:
  - provider response conversion
  - response runtime Anthropic
  - resp outbound client projection
  - servertool response governance

If a required verification fails because of unrelated dirty work, record the exact command, failure, and isolation evidence. Do not claim full closeout unless target-related failures are fixed.

## Done Definition

- The response-side TS semantic residue selected for this slice is gone or Rust-owned.
- Remaining TS response code is justified as IO glue, native wrapper, type-only, or documented future residue.
- New or updated gates fail on the removed residue reappearing.
- Required docs and maps are updated.
- Review is complete.
- Targeted verification passes.
- Commit is created with only related files.

## 2026-06-08 Slice: Anthropic Response Runtime Projection

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts` still owned response-side semantic residue:
  - Anthropic `payload.data` unwrap.
  - Responses reasoning/output-meta registry consume.
  - Responses payload snapshot / passthrough alias consume and re-register.
  - Responses snapshot to chat `semantics` restore.
  - Internal continuation `requestId` stripping.
- Rust already owned the base Anthropic message projection and Responses-to-chat projection, so the closeout unit was to compose those Rust owners behind one full native entrypoint and delete the TS semantic glue.

### Implementation Result

- Added Rust full owner `build_openai_chat_from_anthropic_message_full`.
- Kept TS `buildOpenAIChatFromAnthropicMessage` as native invocation + JSON parse glue only.
- Moved hidden reasoning signature / redacted reasoning / dot-only reasoning handling into Rust.
- Moved Responses retention registry consume/re-register and snapshot semantics restore into Rust.
- Added native export `buildOpenaiChatFromAnthropicMessageFullJson` and required-export coverage.
- Added residue gate blocking TS registry/snapshot restore helpers from returning to `response-runtime-anthropic.ts`.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` with `hub.response_anthropic_client_projection`.

### Verification Evidence

- PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config sharedmodule/llmswitch-core/jest.config.cjs --runTestsByPath sharedmodule/llmswitch-core/src/conversion/hub/response/__tests__/response-runtime.anthropic-hidden-reasoning.test.ts --runInBand --no-cache --forceExit`
- PASS: `cargo test -p router-hotpath-napi anthropic --lib -- --nocapture`
- PASS: `cargo test -p router-hotpath-napi resolve_anthropic_chat_completion_outcome --lib -- --nocapture`
- PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- PASS: `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- PARTIAL: `npm run jest:run -- --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/red-tests/hub_pipeline_anthropic_response_helpers_must_use_native.test.ts --runInBand --no-cache --forceExit`
  - `tests/red-tests/hub_pipeline_anthropic_response_helpers_must_use_native.test.ts` passed.
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` failed only on existing unrelated dirty servertool stop-message residue in `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`; the new Anthropic response runtime residue gate passed.

## 2026-06-08 Slice: Responses-to-Chat Shared Projection

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts` still owned response-side semantic residue used by the live Responses response path:
  - Responses payload unwrap through `response` / `data`.
  - Chat passthrough snapshot registration for already-chat payloads.
  - OpenAI Responses bridge policy/action execution for `response_inbound`.
  - Responses payload snapshot carrier restore and registry re-registration.
- Rust already owned the base `build_chat_response_from_responses_impl`, bridge action pipeline, bridge policies, and Responses retention registry, so the closeout unit was a Rust full owner that composes those existing owners.

### Implementation Result

- Added Rust full owner `build_chat_response_from_responses_full`.
- Kept TS `buildChatResponseFromResponses` as native invocation + JSON parse glue only.
- Moved unwrap, bridge response actions, passthrough registration, and snapshot registration into Rust.
- Added native export `buildChatResponseFromResponsesFullJson` and required-export coverage.
- Added residue gate blocking TS bridge/registry/snapshot restore helpers from returning to `responses-response-utils.ts`.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` with `hub.response_responses_chat_projection`.

## 2026-06-08 Resume Entry: Provider Response SSE Marker Materialization

Use this section as the short execution entry for the next continuation goal.

### Current Target

Close the next response-side TS semantic residue in:

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`

The suspected residue is provider response SSE marker materialization and classification around:

- `readProviderResponseSseText`
- `isProviderResponseSseMarker`
- `materializeProviderResponseSsePayload`
- `extractProviderResponseSseStream`
- `readProviderResponseSseStreamText`
- `buildProviderSseStreamReadError`

### Boundary

- TS may read Node streams and write HTTP/SSE frames as IO glue.
- Rust must own marker classification, normalized SSE body materialization, and explicit read-error descriptor semantics if those semantics are part of the live Hub response chain.
- Do not move request-side shadow wiring, provider-direct passthrough, VR health/selection, or unrelated provider runtime work into this slice.
- Do not treat empty/invalid SSE as a successful payload. Invalid upstream shape must fail explicitly through the proper response/error path.

### Minimum Slice Plan

1. Re-audit `provider-response.ts` live call graph and classify each helper as IO glue, native wrapper, type-only, or semantic residue.
2. Add or update a residue gate before moving/deleting TS semantics.
3. Move the confirmed SSE marker materialization semantics to the matching Rust response owner.
4. Keep TS as stream byte reader/native invocation glue only, or physically delete helpers with no remaining consumer.
5. Update function/verification maps only if a new Rust owner or gate is introduced.
6. Review the diff for fallback, payload trimming, provider-specific Hub logic, metadata/debug leak, and duplicated TS/Rust owners.

### Suggested Focused Verification

- Rust test for the new/updated native SSE marker materialization owner.
- Focused Jest:
  - `tests/server/handlers/responses-handler.anthropic-response-remap.blackbox.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
  - `tests/sharedmodule/provider-response-rust-plan.spec.ts`
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `cargo test -p router-hotpath-napi hub_resp --lib -- --nocapture`
- `npm run verify:architecture-ci`
- `npm run verify:servertool-rust-only`

Known unrelated gate issue from the previous run: `npm run test:unified-hub-shadow` currently fails on request-stage shadow baseline wiring (`hubShadowCompare.baselineProviderPayload missing`). Do not fix that inside this response-side SSE slice unless the scope is explicitly changed.

## 2026-06-08 Slice: Provider Response SSE Marker Materialization

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` still owned response-side semantic residue before the Rust Hub response pipeline entry:
  - SSE `bodyText` / `raw` / nested `data.bodyText` / `data.raw` classification.
  - SSE marker detection for `mode=sse`, `mode=sse_passthrough`, and marker-only `clientStream`.
  - Missing materializable stream/bodyText fail-fast message.
  - Stream read error descriptor semantics (`SSE_DECODE_ERROR`, upstream terminated mapping, 502 retryable provider stage).
- TS stream reading itself is IO glue and remains in TS because it consumes Node `Readable` objects.

### Implementation Result

- Added Rust owner `materialize_provider_response_sse_payload`.
- Added Rust owner `build_provider_sse_stream_read_error_descriptor`.
- Kept TS `materializeProviderResponseSsePayload` as Node stream read + native invocation glue only.
- Removed TS `readProviderResponseSseText`, `isProviderResponseSseMarker`, and `hasProviderSseMarkerSignal`.
- Added native exports:
  - `materializeProviderResponseSsePayloadJson`
  - `buildProviderSseStreamReadErrorDescriptorJson`
- Added residue gate blocking TS SSE marker/bodyText/error descriptor semantics from returning to `provider-response.ts`.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` with `hub.response_provider_sse_materialization`.

### Verification Plan

- `cargo test -p router-hotpath-napi provider_sse --lib -- --nocapture`
- Focused provider response Jest listed in the resume entry.
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `npm run verify:architecture-ci`
- `npm run verify:servertool-rust-only`

## 2026-06-09 Slice: Anthropic Response Helper Shell Deletion

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-helpers.ts` had no live runtime consumer.
- The only source dependency was a type import from `response-runtime-anthropic.ts`; all reasoning/tool normalization semantics already route through the Rust full owners:
  - `build_openai_chat_from_anthropic_message_full`
  - `build_anthropic_response_from_chat_full`
- Keeping the helper as a TS native wrapper shell created dead semantic surface and an old re-entry point for response normalization logic.

### Implementation Result

- Physically deleted `response-runtime-anthropic-helpers.ts`.
- Moved the local `ToolAliasMap` type alias into `response-runtime-anthropic.ts`.
- Updated the red test to require the legacy helper shell to stay deleted and the runtime file to use only full native projection entrypoints.
- Added the deleted helper path to the Anthropic response projection forbidden paths in `docs/architecture/function-map.yml`.
- Updated `docs/architecture/verification-map.yml` notes to lock the deletion boundary.

### Verification Evidence

- PASS: `npm run jest:run -- --runTestsByPath tests/red-tests/hub_pipeline_anthropic_response_helpers_must_use_native.test.ts tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand --no-cache --forceExit`
- PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config sharedmodule/llmswitch-core/jest.config.cjs --runTestsByPath sharedmodule/llmswitch-core/src/conversion/hub/response/__tests__/response-runtime.anthropic-hidden-reasoning.test.ts --runInBand --no-cache --forceExit`
- PASS: `npm run verify:hub-response-anthropic-native`
- PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- PASS: `npm run verify:function-map-compile-gate`

## 2026-06-09 Slice: Provider Response Converter Projection Fallback Deletion

### Audit Result

- `src/server/runtime/http-server/executor/provider-response-converter.ts` still had response-side semantic residue after bridge conversion:
  - Provider-specific `/v1/responses` bridge bypass for one provider family.
  - TS `hasChatToolCalls` and `hasResponsesFunctionCalls` shape predicates.
  - A post-bridge rebuild path that called `buildResponsesPayloadFromChatWithNative` when converted Responses output lacked function calls.
- This kept a TS decision point that could override the Rust bridge/native response projection after the canonical converter had already run.

### Implementation Result

- Deleted the provider-specific bridge bypass.
- Deleted `hasChatToolCalls` and `hasResponsesFunctionCalls`.
- Deleted the post-bridge Responses rebuild branch.
- Kept the converter as bridge invocation, native tool argument normalization, servertool orchestration glue, timing, and HTTP/SSE wrapper handling.
- Added `tests/red-tests/hub_pipeline_provider_response_converter_no_ts_projection_fallback.test.ts` to block provider-specific response bridge branches and TS post-bridge projection fallback from returning.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` for the new gate.

### Verification Evidence

- PASS: `npm run jest:run -- --runTestsByPath tests/red-tests/hub_pipeline_provider_response_converter_no_ts_projection_fallback.test.ts --runInBand --no-cache --forceExit`
- PASS: `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts --runInBand --no-cache --forceExit`
- PASS: `npm run jest:run -- --runTestsByPath tests/sharedmodule/provider-response-rust-plan.spec.ts --runInBand --no-cache --forceExit`
- PASS: `npx tsc --noEmit --pretty false`
- PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- PASS: `cargo test -p router-hotpath-napi build_responses_payload_from_chat --lib -- --nocapture`
- PASS: `npm run verify:function-map-required-tests`
- PASS: `npm run verify:function-map-paths`
- PASS: `npm run verify:function-map-forbidden-mentions`

## 2026-06-09 Slice: Responses Response Utils Zero-Consumer Wrapper Deletion

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts` still exported two response-side TS native wrapper functions:
  - `collectToolCallsFromResponses`
  - `resolveFinishReason`
- `rg` found no live source, test, docs, or script consumer for either wrapper; matches were limited to the definitions themselves.
- The underlying Rust owner remains `shared_responses_response_utils.rs`; the live shared Responses-to-Chat projection uses `buildChatResponseFromResponsesFullWithNative`.

### Implementation Result

- Physically deleted the two zero-consumer TS wrapper exports from `responses-response-utils.ts`.
- Kept `buildChatResponseFromResponses` as full-native invocation and JSON parse glue.
- Added `tests/red-tests/hub_pipeline_responses_response_utils_zero_consumer_wrappers_deleted.test.ts` to prevent the old TS wrapper exports and native imports from returning.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` to include the new deletion gate.

## 2026-06-09 Slice: Reasoning Tool Parser Shell Deletion

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-parser.ts` was a zero-consumer TS native wrapper around `extractToolCallsFromReasoningTextWithNative`.
- `rg` found no live import or symbol consumer outside the file itself; the native capability remains exported directly through `sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.ts`.
- Keeping the parser shell created a duplicate response-side tool extraction surface next to the Rust/native text-markup owner.

### Implementation Result

- Physically deleted `reasoning-tool-parser.ts`.
- Added `tests/red-tests/hub_pipeline_reasoning_tool_parser_shell_deleted.test.ts` to require the helper shell to stay deleted and to verify the native text-markup owner still exposes `extractToolCallsFromReasoningTextWithNative`.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` to include the deletion gate.

## 2026-06-09 Slice: Provider Response Servertool Runtime Action Planner

### Audit Result

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` still interpreted Rust `servertoolRuntimeAction` payloads in TS:
  - Branching on `requireReenterPipeline` and `requireRuntimeExecutor`.
  - Deciding missing runtime executor errors.
  - Owning `SERVERTOOL_FOLLOWUP_FAILED` / `SERVERTOOL_HANDLER_FAILED` descriptors and unsupported-action handling.
- The live IO callback execution must remain in TS, but the response-side action plan and error descriptor are Hub response semantics and belong to Rust.

### Implementation Result

- Added Rust owner `plan_provider_response_servertool_runtime_actions` in `hub_pipeline_lib/effect_plan.rs`.
- Added native export `planProviderResponseServertoolRuntimeActionsJson`.
- Kept TS `provider-response.ts` as native invocation plus IO callback glue:
  - It passes runtime action payloads and executor availability into Rust.
  - It executes returned `executionPlans` through `runServertoolResponseStageOrchestrationShell`.
  - It throws `ProviderProtocolError` only from Rust-provided error descriptors.
- Added residue gate coverage blocking TS action branching, TS missing-executor descriptors, unsupported-action ownership, and TS chat payload reader revival.
- Updated `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` under `hub.response_post_servertool_client_projection`.

## 2026-06-09 Slice: Shared Response Zero-Consumer Wrapper Deletion

### Audit Result

- The live response path still exposed several zero-consumer TS/native wrapper entrypoints in shared conversion files:
  - `extractOutputSegments` and `normalizeContentPart` in `output-content-normalizer.ts`.
  - `normalizeChatResponseReasoningTools` in `reasoning-tool-normalizer.ts`.
  - `bridgeToolToChatDefinition`, `chatToolToBridgeDefinition`, `stringifyArgs`, `ToolCallFunction`, and `ToolCallItem` in `tool-mapping.ts`.
  - `normalizeResponsesToolCallIds` and `resolveToolCallIdStyle` in `responses-tool-utils.ts`.
- `rg` found no live source consumer for these wrapper exports. Remaining live callers either use the full Rust-owned response projection or call the list/native owner directly.
- Keeping these wrappers left duplicate response-side tool/reasoning/output mapping surfaces beside the Rust owners.

### Implementation Result

- Physically deleted the zero-consumer TS wrapper exports from the shared conversion files above.
- Removed the unused single-tool native bridge wrappers and Rust NAPI exports for `bridgeToolToChatDefinitionJson`, `chatToolToBridgeDefinitionJson`, `extractOutputSegmentsJson`, and `normalizeOutputContentPartJson`.
- Removed the remaining public native wrapper / required-export surface for zero-consumer response helpers:
  - `collectToolCallsFromResponsesWithNative` / `collectToolCallsFromResponsesJson`
  - `resolveFinishReasonWithNative` / `resolveFinishReasonJson`
  - `normalizeResponsesToolCallIdsWithNative` / `normalizeResponsesToolCallIdsJson`
  - `resolveToolCallIdStyleWithNative` / `resolveToolCallIdStyleJson`
- Kept live wrappers that still act as thin native invocation glue, such as `normalizeMessageContentParts`, `normalizeMessageReasoningTools`, `mapBridgeToolsToChat`, `mapChatToolsToBridge`, and `createToolCallIdTransformer`.
- Updated coverage scripts so they exercise only live exports.
- Added `tests/red-tests/hub_pipeline_shared_response_wrappers_deleted.test.ts` to lock TS wrapper deletion, native bridge deletion, required-export deletion, and Rust NAPI export deletion.
- Updated `tests/red-tests/hub_pipeline_responses_response_utils_zero_consumer_wrappers_deleted.test.ts` to also fail if those deleted response helper surfaces reappear through the native barrel or required-export gate.

### Verification Evidence

- PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- PASS: `npm run jest:run -- --runTestsByPath tests/red-tests/hub_pipeline_responses_response_utils_zero_consumer_wrappers_deleted.test.ts tests/red-tests/hub_pipeline_shared_response_wrappers_deleted.test.ts tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand --no-cache --forceExit`
