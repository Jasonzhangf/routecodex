# SSE Full Rustification Execution Plan

## 1. Goal And Acceptance Criteria

Goal: fully rustify RouteCodex SSE codec/projection runtime so TS no longer owns SSE semantic projection, decode aggregation, reasoning/tool/function_call normalization, fallback/salvage, or lifecycle decisions.

Acceptance criteria:

- `src/server/handlers/handler-response-sse.ts` and `src/modules/llmswitch/bridge/responses-sse-bridge.ts` remain transport-only: frame write, keepalive, timeout, abort/client-close, snapshot, and metadata closeout release only.
- `sharedmodule/llmswitch-core/src/sse/**` no longer contains primary protocol semantic implementations. TS files either become native wrappers / IO shells or are physically deleted.
- Rust owns SSE parse, encode, decode aggregation, event payload construction, sequencing, usage validation, reasoning projection, tool/function call delta construction, and fail-fast validation.
- Blackbox parity tests lock observable client/provider behavior before replacement and stay green after each Rust cutover.
- Whitebox tests lock each Rust module's node contract and each TS shell's thin-wrapper boundary.
- Gate prevents deleted TS semantic owners from returning.
- No fallback, no silent salvage, no dual long-term truth.

## 2. Scope And Boundaries

In scope:

- `sharedmodule/llmswitch-core/src/sse/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-*sse*.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*sse*.rs`
- SSE-related function map, verification map, mainline call map, wiki/manifest if symbols move
- SSE focused tests under `tests/sharedmodule/**`, `tests/server/handlers/**`, `tests/modules/llmswitch/bridge/**`
- SSE gates under `scripts/architecture/verify-sse-architecture-boundary.mjs` and `verify-responses-sse-business-module.mjs`

Out of scope:

- stopless / servertool behavior except proving SSE does not own it
- provider routing, retry, health, VR policy
- continuation save/restore semantics except proving SSE does not own it
- broad protocol redesign outside adjacent SSE encode/decode contracts

## 3. Current State Summary

Server SSE transport is already mostly clean:

- `handler-response-sse.ts` currently handles stream source, headers, write/end, keepalive, timeout, client close, snapshot, and closeout release.
- `responses-sse-bridge.ts` only exports keepalive transport facade.
- Current gates pass: `verify:responses-sse-business-module`, `verify:sse-architecture-boundary`, and `verify:function-map-compile-gate`.

Not yet rustified:

- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/chat-sequencer.ts` still owns reasoning/content/tool/function_call/finish_reason sequencing.
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts` still owns TS stream aggregation, timeout state, parsing, reasoning normalization, and final response construction.
- Responses / Anthropic / Gemini SSE codec files still contain TS owner code even where some native payload builders exist.
- Current gate does not fail merely because TS projection remains; it only blocks known fallback/salvage/business leakage markers.

## 4. Target Module Ownership

### 4.1 Server Transport Surface

Owner feature:

- `server.responses_sse_bridge_surface`

Allowed TS responsibilities:

- HTTP headers and status
- Readable stream pipe/unpipe
- `res.write` / `res.end`
- keepalive comment frame
- timeout and client abort wiring
- diagnostic snapshot
- metadata center closeout release

Forbidden TS responsibilities:

- schema stripping or stopless interception
- `required_action` detection
- terminal/probe/repair decisions
- continuation save/restore
- function/tool call repair
- JSON/SSE semantic projection
- history/context repair

### 4.2 Rust SSE Codec Owners

Target Rust modules:

- `sse_wire_parser.rs`: line/event parser and strict SSE frame parsing.
- `sse_chat_encode.rs`: Chat JSON response to ordered Chat SSE event frames.
- `sse_chat_decode.rs`: Chat SSE event stream to Chat JSON response.
- `sse_responses_encode.rs`: Responses JSON response to ordered Responses SSE event frames.
- `sse_responses_decode.rs`: Responses SSE event stream to Responses JSON response.
- `sse_anthropic_encode.rs` / `sse_anthropic_decode.rs`.
- `sse_gemini_encode.rs` / `sse_gemini_decode.rs`.
- Shared strict helpers may live under `sse_contract.rs` / `sse_usage.rs` / `sse_reasoning.rs`, but only if they are not second owners of Hub Chat Process semantics.

Existing Rust files may be reused or split:

- `hub_resp_outbound_sse_stream.rs`
- `chat_sse_event_payload.rs`
- `responses_sse_event_payload.rs`
- `hub_resp_inbound_sse_decode_semantics.rs`
- `hub_resp_inbound_sse_stream_sniffer.rs`

### 4.3 TS End State

Allowed TS end state:

- Native binding wrapper
- Async iterable / Node stream IO adapter
- Thin input/output JSON marshal
- Public barrel exports

Forbidden TS end state:

- Protocol semantic sequencing
- Message/content/reasoning normalization
- tool/function_call shape conversion
- status / finish_reason synthesis
- usage normalization
- fallback/salvage/repair
- hidden dual implementation beside Rust

## 5. Blackbox Parity Test Lock

Blackbox tests must be added before each replacement. They compare observable behavior, not implementation.

### 5.1 Chat JSON -> SSE Client Output

Feature:

- `sse.chat_stream_projection`

Test file:

- `tests/sharedmodule/sse-rust-parity-chat-json-to-sse.blackbox.spec.ts`

Fixtures:

- Assistant text stop response.
- Reasoning-only assistant response.
- Text plus reasoning response.
- Tool calls response with multiple calls and argument deltas.
- Legacy `function_call` input must fail or be handled only if Rust contract explicitly owns that legacy mapping.
- Missing `finish_reason` must fail fast.
- Missing role/content/tool/reasoning truth must fail fast.

Assertions:

- SSE event order is stable: role -> reasoning/content/tool deltas -> finish -> done.
- Client-visible frame payloads match pre-rustification baseline for valid fixtures.
- No internal metadata appears.
- Invalid fixtures produce explicit error, not synthesized success.

### 5.2 Chat SSE -> JSON Provider Decode

Test file:

- `tests/sharedmodule/sse-rust-parity-chat-sse-to-json.blackbox.spec.ts`

Fixtures:

- Standard OpenAI chat chunk stream.
- Usage-bearing final chunk.
- Tool call delta stream.
- Function call delta stream if still supported by contract.
- Incomplete stream.
- Malformed chunk after valid content.

Assertions:

- Final JSON equals existing valid baseline.
- Usage values are strict and match Rust normalization.
- Tool call arguments aggregate exactly.
- Incomplete/malformed stream fails fast with the existing public error code where applicable.
- No silent completion when malformed semantic chunks appear before terminal truth.

### 5.3 Responses JSON -> SSE Client Output

Test file:

- `tests/sharedmodule/sse-rust-parity-responses-json-to-sse.blackbox.spec.ts`

Fixtures:

- `response.created -> in_progress -> output_text delta/done -> completed -> done`.
- Function call arguments delta/done.
- Required action.
- Reasoning summary events.
- Custom tool / apply_patch shape if currently client-visible.
- Missing `status`, missing `created_at`, missing text, missing function args.

Assertions:

- Frame event names and order match baseline for valid fixtures.
- Required action/tool calls are emitted only from finalized semantic response truth.
- Invalid fixtures fail fast and do not emit terminal success frames.
- Metadata/runtime carrier fields do not leak into SSE frames.

### 5.4 Responses SSE -> JSON Provider Decode

Test file:

- `tests/sharedmodule/sse-rust-parity-responses-sse-to-json.blackbox.spec.ts`

Fixtures:

- Provider Responses SSE with output text.
- Provider Responses SSE with function call arguments.
- Provider Responses SSE with reasoning summary.
- Provider stream error event.
- Stream closes before `response.completed` / `response.done`.

Assertions:

- Final Responses JSON equals baseline for valid fixtures.
- Function call arguments aggregate exactly.
- Reasoning summary aggregates exactly.
- Incomplete provider stream returns the same observable error category, not success salvage.

### 5.5 Anthropic / Gemini Encode Decode

Test files:

- `tests/sharedmodule/sse-rust-parity-anthropic-sse.blackbox.spec.ts`
- `tests/sharedmodule/sse-rust-parity-gemini-sse.blackbox.spec.ts`

Fixtures:

- Text-only streams.
- Tool-use streams.
- Reasoning/thinking streams where supported.
- Missing required role/content/part/tool fields.

Assertions:

- Valid event sequence and final JSON match baseline.
- Invalid semantic frames fail fast.
- No provider-specific branch enters shared registry/writer.

### 5.6 Server Handler Client Contract

Test file:

- extend `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`

Assertions:

- Handler writes only already-finalized frames.
- Handler does not inspect `required_action`, terminal state, schema, or continuation.
- Handler behavior is unchanged after Rust codec cutover for valid streams.
- Missing `sseStream` still fail-fast through transport error path.

## 6. Whitebox Node Contract Tests

Whitebox tests lock internal module contracts after blackbox parity exists.

### 6.1 Rust Unit Tests

Rust test groups:

- `cargo test -p router-hotpath-napi sse_wire_parser --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_chat_encode --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_chat_decode --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_responses_encode --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_responses_decode --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_anthropic --lib -- --nocapture`
- `cargo test -p router-hotpath-napi sse_gemini --lib -- --nocapture`

Required whitebox cases:

- Strict required field validation.
- Stable event ordering.
- Tool/function argument aggregation.
- Usage token validation.
- Reasoning summary/text validation.
- Incomplete stream detection.
- Non-object / malformed payload rejection.
- No default model/id/timestamp/status synthesis unless protocol contract explicitly owns it.

### 6.2 Native Binding Tests

Test file:

- extend `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`

Assertions:

- Every new Rust SSE export exists.
- TS wrappers call native export by name.
- No wrapper has a JS semantic fallback branch.
- Native error surfaces as thrown error / rejected promise, not swallowed result.

### 6.3 TS Thin Shell Boundary Tests

Test file:

- `tests/sharedmodule/sse-ts-thin-shell-boundary.spec.ts`

Assertions:

- Former semantic functions no longer exist in TS files.
- TS wrappers contain only marshal/native-call/stream IO.
- `chat-sequencer.ts`, `chat-sse-to-json-converter.ts`, `responses-json-to-sse-converter.ts`, `responses-sse-to-json-converter.ts` are either deleted or reduced to native wrapper surfaces.
- `verify:sse-architecture-boundary` contains explicit deny markers for removed TS semantic owners.

### 6.4 Server Boundary Tests

Existing tests to keep green:

- `tests/red-tests/server_responses_sse_business_module_contract.test.ts`
- `tests/red-tests/server_responses_sse_surface_single_owner.test.ts`
- `tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts`
- `tests/server/handlers/handler-response-sse-wrapper-contract.spec.ts`
- `tests/server/handlers/responses-handler.sse-terminal-event.blackbox.spec.ts`

Assertions:

- SSE handler remains transport-only.
- No metadata leak.
- No force-SSE JSON bridge fallback.
- No semantic frame drop/rewrite in handler.

## 7. Implementation Sequence

Each phase must follow:

1. Add blackbox parity tests and prove they pass against the current TS baseline.
2. Add Rust whitebox tests for the target module and prove they are red if native implementation is missing.
3. Implement Rust module.
4. Add native binding wrapper.
5. Switch TS caller to native.
6. Remove old TS semantic implementation physically.
7. Extend architecture gate to forbid old TS markers.
8. Run focused blackbox + whitebox + gates.
9. Commit that module slice before moving on.

### Phase 0. Contract And Gate Preparation

Files:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/sse-chat_stream_projection-mainline.md`
- `scripts/architecture/verify-sse-architecture-boundary.mjs`

Work:

- Add explicit rustification closeout state for each SSE feature.
- Add required parity tests to verification map.
- Add deny markers for TS semantic owner functions:
  - `normalizeMessageReasoningTools` import inside `src/sse/**`
  - `normalizeChatMessageContent` import inside `src/sse/**`
  - `dispatchReasoning` import inside `src/sse/**`
  - `normalizeFunctionCall(` inside `chat-sequencer.ts`
  - TS context maps in decode converters unless only IO stream state remains
  - TS `finish_reason` synthesis / override
  - TS `required_action` synthesis outside Rust owner

### Phase 1. Wire Parser Rust Owner

Target:

- Replace `sse-to-json/parsers/sse-parser.ts` semantics with Rust parser.

Tests:

- `sse-rust-parity-wire-parser.blackbox.spec.ts`
- Rust `sse_wire_parser` unit tests.

Expected TS end state:

- TS wrapper passes bytes/text to native parser and yields typed events.

### Phase 2. Chat JSON -> SSE Encode

Target TS files:

- `json-to-sse/chat-json-to-sse-converter.ts`
- `json-to-sse/sequencers/chat-sequencer.ts`
- `json-to-sse/event-generators/chat.ts`

Rust target:

- `sse_chat_encode.rs`

Key migration:

- Move role/content/reasoning/tool call/finish/done event sequencing to Rust.
- Move reasoning projection behavior to Rust only if it is truly SSE projection; if it is broader client response semantics, move it to `HubRespOutbound04ClientSemantic` Rust owner before SSE.
- Decide and lock legacy `function_call` behavior. If support remains, Rust owns it; otherwise invalid legacy shape fails fast.

### Phase 3. Chat SSE -> JSON Decode

Target TS files:

- `sse-to-json/chat-sse-to-json-converter.ts`
- `sse-to-json/builders/response-builder.ts` if involved

Rust target:

- `sse_chat_decode.rs`

Key migration:

- Move event aggregation, tool/function argument accumulation, finish_reason handling, usage normalization, incomplete stream detection to Rust.
- TS only adapts AsyncIterable chunks into native decode input or uses native incremental state if streaming decode is required.

### Phase 4. Responses JSON -> SSE Encode

Target TS files:

- `json-to-sse/responses-json-to-sse-converter.ts`
- `json-to-sse/sequencers/responses-sequencer.ts`
- `json-to-sse/event-generators/responses.ts`

Rust target:

- `sse_responses_encode.rs`

Key migration:

- Move response lifecycle event ordering and output item/function/reasoning/required_action event generation to Rust.
- Keep stopless/continuation/schema decisions outside SSE; input must already be finalized response truth.

### Phase 5. Responses SSE -> JSON Decode

Target TS files:

- `sse-to-json/responses-sse-to-json-converter.ts`

Rust target:

- `sse_responses_decode.rs`

Key migration:

- Move Responses event aggregation, function call arg aggregation, reasoning summary aggregation, terminal detection, error event propagation, and incomplete stream detection to Rust.

### Phase 6. Anthropic / Gemini SSE

Target TS files:

- `json-to-sse/anthropic-json-to-sse-converter.ts`
- `sse-to-json/anthropic-sse-to-json-converter.ts`
- `json-to-sse/gemini-json-to-sse-converter.ts`
- `sse-to-json/gemini-sse-to-json-converter.ts`
- protocol-specific sequencers/serializers

Rust targets:

- `sse_anthropic_encode.rs`
- `sse_anthropic_decode.rs`
- `sse_gemini_encode.rs`
- `sse_gemini_decode.rs`

### Phase 7. Registry / Writer Closeout

Target TS files:

- `registry/sse-codec-registry.ts`
- `shared/writer.ts`
- `index.ts`

Target:

- Registry is only native binding selection / public barrel.
- Writer is only backpressure IO and serialization of already-native frames.
- No protocol semantic branch remains in registry/writer.

## 8. Required Verification Stack

Per module slice:

- Focused new blackbox parity test for that module.
- Focused Rust whitebox test for that module.
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p tsconfig.json --pretty false`
- `npm run verify:sse-architecture-boundary`
- `npm run verify:responses-sse-business-module`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `git diff --check`

Aggregate closeout:

- Run every `tests/sharedmodule/*sse*.spec.ts`.
- Run every `tests/server/handlers/*sse*.spec.ts`.
- Run `npm run build:base`.
- If runtime-impacting route is affected, rebuild/install and replay a real `/v1/responses` and `/v1/chat/completions` SSE sample through `routecodex restart --port <port>` and canonical `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`.

## 9. Completion Definition

The rustification is complete only when:

- Function map lists Rust owner modules for every SSE semantic feature.
- Mainline call map no longer points semantic SSE edges at TS sequencer/converter implementations except thin wrappers.
- `verify:sse-architecture-boundary` fails if removed TS semantic owners return.
- All parity blackbox tests pass.
- All Rust whitebox tests pass.
- TS wrappers are visibly thin and have tests proving no fallback.
- Old TS semantic implementations are physically deleted or reduced to native wrappers.
- Live/replay evidence exists for at least one Chat SSE and one Responses SSE path, or the report explicitly states why live replay was unavailable and what source replay replaced it.

## 10. Risks

- Risk: moving reasoning projection into SSE when it actually belongs to response outbound.
  Mitigation: before migration, classify each semantic as `HubRespOutbound04ClientSemantic` vs SSE line encoding.
- Risk: long dual TS/Rust truth.
  Mitigation: each module cutover deletes the old TS semantic implementation in the same slice.
- Risk: parity tests lock wrong old behavior.
  Mitigation: blackbox fixtures classify valid baseline vs known-bad fallback behavior; invalid fallback paths must be locked as failure, not parity success.
- Risk: gate false positives.
  Mitigation: use exact old markers and allowed wrapper patterns, not broad keyword bans.

