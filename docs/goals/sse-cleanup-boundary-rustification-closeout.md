# SSE Cleanup Boundary Rustification Closeout

## Objective

把 `/v1/responses` 和 SSE 相关 TS 残留收口到“transport-only / thin shell”，把仍然承载语义修复、生命周期策略、usage 归一化、direct relay 重投影、provider SSE materialization/error descriptor 的真源下沉到 Rust owner，或在确认 dead residue 后物理删除。

## Success Criteria

- `src/server/handlers/handler-response-sse.ts` 只保留 HTTP/SSE transport 行为。
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts` 只保留 facade / shell 行为。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 不再长期承载 usage normalization、conversation cleanup policy、relay SSE reproject policy。
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 只保留 Node stream bytes 读取、native 调用、IO glue。
- `sharedmodule/llmswitch-core/src/sse/**` 不再出现 fallback / salvage / synthetic truth / silent swallow / provider-specific residue。
- 所有越界语义都由 gate 锁死，且每个 slice 都有正反测试。
- 至少一次 live / replay SSE 证据，或明确说明不可 replay 的缺口与替代 probe。

## Current Audit Matrix

| file path | current symbol / function | current responsibility | classification | unique owner | handling | must-run tests / gates |
| --- | --- | --- | --- | --- | --- | --- |
| `src/server/handlers/handler-response-sse.ts` | `sendSseBridgeError`, `sendStructuredSseError`, `extractStructuredSseErrorPayload`, `streamResponsesJsonAsSse`, `streamChatCompletionsJsonAsSse`, `dispatchResponsesJsonAsSse` | SSE transport, stream pipe/unpipe, closeout, frame write, diagnostic snapshot | `transport-only` for write/close; `semantic-borderline` where it still decides chat->responses projection or structured error projection | `server.responses_response_handler_bridge_surface` + Rust response projection owner | keep thin transport shell; move any semantic decision out of handler; delete dead repair if confirmed | `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `src/modules/llmswitch/bridge/responses-sse-bridge.ts` | `prepareResponsesJsonBodyForSseBridgeForHttp`, re-exports | facade / bridge shell | `transport-only` for simple re-export surface | Rust response projection owner for any semantic decision | 2026-06-30 slice physically removed `reprojectDirectChatToolCallStreamForHttp`; keep facade only | `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `src/modules/llmswitch/bridge/responses-response-bridge.ts` | `resolveResponsesConversationClearReasonForHttp`, `rebindResponsesConversationRequestIdForHttp`, client projection dispatch helpers | request-id rebind, client projection native call shell, request log context | `native thin shell`; prior `semantic-borderline` helpers removed | Rust response/continuation owner for lifecycle truth; transport owner only for IO | 2026-06-30 slice physically removed chat usage normalization, client-close/failure cleanup policy, relay SSE reprojection helper, and request-id cleanup fanout helper | `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/responses-provider-owned-continuation-reroute.blackbox.spec.ts`, `npm run verify:responses-sse-business-module`, `npm run verify:sse-architecture-boundary` |
| `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` | `materializeProviderResponseSsePayload`, `extractProviderResponseSseStream`, `readProviderResponseSseStreamText`, `buildProviderSseStreamReadError`, `convertProviderResponse` | Node stream read, native SSE materialization call, effect-plan application, client projection orchestration | `native thin shell` for stream read; `semantic-borderline` for anything beyond read/call/IO | Rust owner under `hub.response_provider_sse_materialization` + response projection owner | keep TS as thin shell only; move materialization/error descriptor/effect-plan truth to Rust; delete duplicate TS semantics if any remain | `tests/sharedmodule/provider-response-rust-plan.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`, `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`, `npm run verify:hub-response-provider-sse-materialization`, `npm run verify:sse-architecture-boundary` |
| `sharedmodule/llmswitch-core/src/sse/**` | `responses-json-to-sse-converter.ts`, `responses-sse-to-json-converter.ts`, `chat-sse-to-json-converter.ts`, `anthropic-json-to-sse-converter.ts`, `gemini-json-to-sse-converter.ts`, serializers / sequencers / registry / writer | SSE codec / serialization / decode / frame generation | `dead residue` when it still contains fallback / salvage / synthetic / provider-specific markers; otherwise `native target` for migration | Rust SSE codec / serializer / parser owners | physical delete dead residue; keep only proven thin shell; add gate markers for every deleted anti-pattern | `tests/sharedmodule/sse-no-silent-failure.spec.ts`, `tests/sharedmodule/chat-sse-no-salvage.spec.ts`, `tests/sharedmodule/sse-parser-no-recovery.spec.ts`, `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts`, `npm run verify:sse-architecture-boundary` |

## Test Design

### Whitebox

- Lock function owner and stage boundary for handler, bridge, and provider-response shell.
- Prove transport-only paths still write headers, frames, pipe/unpipe, close cleanly, and record transport observation.
- Prove semantic paths do not survive in TS when the same behavior can be owned by Rust or deleted.
- Prove `buildProviderSseStreamReadError` only wraps read failures and does not become a second semantic owner.

### Blackbox

- Client-facing: SSE success path still streams terminal frames, client close still closes transport, and no internal metadata leaks.
- Provider-facing: direct/relay response projection still produces the right upstream/client observable shape, but no TS helper rewrites continuation or lifecycle truth.
- Boundary-facing: partial stream salvage, synthetic truth generation, and provider-specific SSE residue stay rejected.

## Verification Gates

Required gates for each slice:

- `npm run verify:sse-architecture-boundary`
- `npm run verify:responses-sse-business-module`
- `npm run verify:hub-response-provider-sse-materialization`
- `npm run verify:hub-response-responses-chat-projection`
- `npm run verify:debug-unified-surface`
- `npm run verify:error-pipeline-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-mainline-node-id-consistency`
- `npx tsc -p tsconfig.json --pretty false`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `npm run build:base`
- `git diff --check`

Focused tests to use as slice gates:

- `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`
- `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`
- `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`
- `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
- `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
- `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
- `tests/sharedmodule/provider-response-rust-plan.spec.ts`
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
- `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
- `tests/red-tests/server_sse_metadata_guard_e2e.test.ts`

## Slice Order

1. Add or update red / reverse tests for the exact residue being removed.
2. Move semantic truth to Rust owner or delete dead residue.
3. Extend gate markers so the removed expression cannot return.
4. Re-run focused tests, then the required gates.
5. Replay a real sample or live probe before calling the slice closed.

## Open Risks

- `responses-response-bridge.ts` has had the first usage/cleanup/reprojection policy slice removed, but remaining projection helper code still needs review against Rust owner boundaries.
- `provider-response.ts` still does stream read + materialization orchestration in TS and may need another shrink pass.
- `handler-response-sse.ts` still contains projection decisions for chat / responses paths and may need further owner cuts.
- `sharedmodule/llmswitch-core/src/sse/**` still contains many legacy markers; each must be validated against the gate before deletion.

## Slice Log

### 2026-06-30 bridge helper deletion slice

- Red evidence: after adding forbidden markers, `npm run verify:responses-sse-business-module` failed on direct chat tool-call stream reprojection, chat usage normalization, client-close/failure conversation cleanup policy, and relay Responses SSE reprojection policy.
- Fix: deleted `reprojectDirectChatToolCallStreamForHttp`, `normalizeChatUsagePayloadForHttp`, `shouldClearResponsesConversationOnClientCloseForHttp`, `shouldClearResponsesConversationOnFailureForHttp`, `clearResponsesConversationRequestIdsForHttp`, `shouldReprojectRelayResponsesSseForHttp`, and `resolveRelayResponsesClientSseStreamForHttp` from TS source and tracked JS/DTS bridge surfaces; deleted old `provider-response-relay-sse.spec.ts` that locked the wrong TS owner.
- Verification so far: `npm run verify:responses-sse-business-module` PASS, provider-response converter contract PASS, root `tsc` PASS, sharedmodule `tsc` PASS.

### 2026-06-30 provider-response SSE read-error wrapper slice

- Red evidence: `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` still carried a local `buildProviderSseStreamReadError` wrapper around the native descriptor.
- Fix: removed the local helper and moved the wrapper construction into `materializeProviderResponseSsePayload`; added residue gate coverage in `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`.
- Additional fix: Rust Responses client projection now replaces missing or non-positive `created_at` in existing Responses payloads before SSE encoding; Rust openai-chat response stream planning now only emits `servertoolRuntimeAction` when stopMessage/stopless runtime is explicitly active. TS `provider-response.ts` only post-projects servertool payloads after an orchestration action actually executed, so inert action plans cannot overwrite Rust `streamPipe.payload`.
- Positive tests: provider-response focused Jest now covers non-stream body, OpenAI chat stream, Responses stream stopless projection, no-session no-projection, disabled stopMessage no-projection, and runtime callback paths.
- Reverse tests: Rust `response_stream_path_returns_stream_pipe_effect_plan` proves ordinary chat streaming emits `streamPipe` + `runtimeStateWrite` but no `servertoolRuntimeAction`; Rust `build_responses_payload_from_chat_core_supplies_created_at_for_existing_response_payload` proves `created_at: 0` is replaced before Responses SSE encode.
- Verification: `cargo test -p router-hotpath-napi build_responses_payload_from_chat_core_supplies_created_at_for_existing_response_payload --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi normalize_openai_chat_reasoning_outbound --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi response_stream_path_returns_stream_pipe_effect_plan --lib -- --nocapture` PASS; `cargo test -p router-hotpath-napi response_stream_stop_with_runtime_callbacks_returns_stream_and_servertool_effects --lib -- --nocapture` PASS; `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS; `tests/sharedmodule/provider-response-rust-plan.spec.ts` PASS 20/20; `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false` PASS; `npm run verify:hub-response-provider-sse-materialization` PASS; `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `git diff --check` PASS.
- Residue audit note: full `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` still has one unrelated red, `llmswitch matrix runner must not reference missing test scripts`, because `scripts/tests/virtual-router-quota-health-restore.mjs` is absent. All provider-response / servertool SSE projection residue cases in that suite passed.

### 2026-06-30 responses-event-serializer static synthesis helpers removed

- Red evidence: `responses-event-serializer.ts` still exposed static `createResponse*` / `createRequiredActionEvent` helpers and used `timestamp ?? Date.now()` to synthesize SSE events in TS.
- Fix: physically deleted the static factory block; kept the serializer as wire-format / parse-only owner; added source gate markers to `verify-sse-architecture-boundary.mjs` and a runtime-surface assertion in `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts`.
- Verification: `npm run verify:sse-architecture-boundary` PASS; `npm run verify:responses-sse-business-module` PASS; `tests/sharedmodule/responses-event-serializer-no-salvage.spec.ts` PASS; sharedmodule `tsc --noEmit` PASS; root `tsc --noEmit` PASS; `git diff --check` PASS.
