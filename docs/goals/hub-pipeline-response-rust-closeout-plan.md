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
