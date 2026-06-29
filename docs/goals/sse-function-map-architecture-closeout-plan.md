# SSE Function Map Architecture Closeout Plan

## 1. Objective

Bring `sharedmodule/llmswitch-core/src/sse` under RouteCodex function-map governance and define the architecture closeout path for SSE parsing, aggregation, serialization, registry, and stream projection.

The first closeout slice is architecture/gate ownership, not a behavior rewrite. Runtime behavior must remain stable while the module becomes queryable, test-mapped, and protected from fallback or duplicate Hub/Provider semantics.

## 2. Current Evidence

Repository inspection on 2026-06-09 shows:

- `docs/architecture/function-map.yml` has 50 active features, but only one SSE-specific feature: `hub.response_provider_sse_materialization`.
- `verify:function-map-compile-gate` passes, but the gate only validates registered features and source anchors; it does not force unregistered large directories to enter the map.
- `sharedmodule/llmswitch-core/src/sse` has 36 TypeScript files and about 12,182 lines:
  - `sse-to-json`: 8 files, about 5,070 lines.
  - `json-to-sse`: 11 files, about 3,570 lines.
  - `types`: 7 files, about 1,910 lines.
  - `shared`: 8 files, about 1,265 lines.
  - `registry`: 1 file, about 206 lines.
  - root barrel: 1 file, about 161 lines.
- Existing SSE local docs exist under `sharedmodule/llmswitch-core/src/sse/`, including `ARCHITECTURE.md`, `TEST_PLAN.md`, and `SSE_IMPLEMENTATION_DATA_ASSESSMENT.md`, but they are not wired into project-level function-map ownership.
- Live call sites prove SSE is active runtime surface:
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts` uses `defaultSseCodecRegistry.get(...).convertSseToJson(...)` for Hub request materialization from streams.
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` uses `codec.convertJsonToSse(...)` for Hub response outbound stream projection.
  - `src/providers/core/runtime/responses-provider.ts` uses `createResponsesSseToJsonConverter()` to decode upstream Responses SSE into provider JSON.
  - `src/server/handlers/handler-response-utils.ts` uses `createResponsesJsonToSseConverter()` to emit client-visible Responses SSE from JSON results.
- Rust already owns low-level SSE parse helpers through NAPI calls used by `sse-to-json/parsers/sse-parser.ts`:
  - `assembleSseEventFromLinesJson`
  - `parseSseEventWithConfigJson`
  - `parseSseStreamWithConfigJson`
- Rust also owns some response stream effect planning via `hub_resp_outbound_sse_stream`, but the broader registry, event aggregation, event sequencing, event serialization, protocol defaults, and several compatibility decisions remain in TS.

## 3. Gap Size

This is a medium-large closeout, not a small map-only patch.

The module is about 12k TS lines and sits on four live runtime paths:

1. Hub inbound stream-to-json request materialization.
2. Hub outbound json-to-stream client projection.
3. Provider Responses upstream SSE decode.
4. HTTP handler client SSE emission.

Current map coverage is narrow:

- Covered: provider response SSE materialization before Rust Hub response pipeline entry.
- Not covered as standalone owners:
  - SSE codec registry and public barrel.
  - Chat SSE JSON-to-SSE and SSE-to-JSON conversion.
  - Responses SSE JSON-to-SSE and SSE-to-JSON conversion.
  - Anthropic SSE JSON-to-SSE and SSE-to-JSON conversion.
  - Gemini SSE JSON-to-SSE and SSE-to-JSON conversion.
  - Common SSE writer, serializers, parser wrapper, and utility layer.
  - SSE protocol event type surfaces.
  - SSE runtime timeout / terminal event / stream-completion policy.

Risk markers found in current TS surface:

- `SseStreamLike = any` and `SseStreamInput = any` in `registry/sse-codec-registry.ts`.
- `unknown` and `Record<string, unknown>` are used as central runtime payload carriers in registry and converters.
- `ResponsesSseToJsonConverterRefactored` has recovery and compatibility comments around missing `response.done` / tool-call stream termination.
- `shared/writer.ts` contains a fallback serializer path after `defaultResponsesEventSerializer.serializeToWire(...)` failure.
- `shared/writer.ts` has TODO/temporary comments for Responses serialization.
- Some protocol-specific parsing/normalization appears in generic converter classes, especially Chat and Responses SSE-to-JSON.

This does not prove runtime is currently broken. It proves SSE still lacks project-level architecture locks for ownership, forbidden paths, and migration target.

## 4. Scope

In scope:

- Add project-level function-map and verification-map ownership for SSE.
- Add source `feature_id:` anchors to the owning SSE files.
- Add gate scripts that verify owner/queryability and prevent fallback patterns from expanding.
- Decide and document the stable SSE chain types and builder names.
- Create red tests or architecture scans for:
  - registry fallback / heuristic protocol detection,
  - inline metadata leak to SSE frames,
  - provider-specific branches in Hub-generic SSE owners,
  - TS duplicate ownership after Rust plans exist,
  - old retired SSE wrapper resurrection.
- Preserve current runtime behavior during initial gate wiring.

Out of scope for the first slice:

- No large runtime rewrite.
- No provider-specific SSE behavior changes.
- No direct passthrough behavior changes.
- No payload trimming or semantic rewrite to make tests pass.
- No fallback compatibility layer.
- No deletion unless proven zero-consumer and separately validated.

## 5. Target Ownership Model

Recommended feature split:

### `sse.codec_registry_surface`

Owner:

- `sharedmodule/llmswitch-core/src/sse/registry/sse-codec-registry.ts`
- `sharedmodule/llmswitch-core/src/sse/index.ts`

Responsibility:

- Register known protocol codecs.
- Resolve protocol to the correct codec.
- Expose public conversion entrypoints.
- Stay a thin dispatch surface only.

Forbidden:

- Payload semantic repair.
- Provider-specific branches.
- Hidden default protocol fallback.
- Metadata mutation.
- Tool governance.

Migration target:

- TS shell first, Rust-backed protocol resolution later if needed.

### `sse.stream_parse_boundary`

Owner:

- `sharedmodule/llmswitch-core/src/sse/sse-to-json/parsers/sse-parser.ts`
- Rust NAPI parser helpers in `router-hotpath-napi`

Responsibility:

- Assemble SSE wire lines into typed raw events.
- Parse stream chunks with buffer continuity.
- Fail-fast on malformed wire events when strict parsing is required.

Forbidden:

- Provider semantic normalization.
- Client response projection.
- Tool governance.
- Silent event recovery as success truth.

Migration target:

- Rust.

### `sse.responses_decode_projection`

Owner:

- `sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json` native materializer surface

Responsibility:

- Convert OpenAI Responses SSE event stream into a Responses JSON object.
- Preserve terminal event semantics and usage/tool/reasoning ordering.
- Surface decode failure as provider/runtime error, not success payload.

Forbidden:

- Hub tool governance.
- Provider retry/reroute policy.
- Client frame repair.
- Metadata injection into payload.

Migration target:

- Rust event aggregation plan, TS stream IO shell.

### `sse.responses_encode_projection`

Owner:

- `sharedmodule/llmswitch-core/src/sse/json-to-sse/responses-json-to-sse-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/sequencers/responses-sequencer.ts`
- `sharedmodule/llmswitch-core/src/sse/shared/serializers/responses-event-serializer.ts`

Responsibility:

- Convert Responses JSON into ordered client-visible Responses SSE events.
- Preserve event order and terminal event contract.
- Emit only client protocol frames.

Forbidden:

- Provider response parsing.
- Hub response governance.
- Tool-call semantic repair.
- Fallback serialization after known serializer failure.

Migration target:

- Rust event sequencing/serialization plan, TS Node stream shell.

### `sse.chat_stream_projection`

Owner:

- `sharedmodule/llmswitch-core/src/sse/json-to-sse/chat-json-to-sse-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/shared/chat-serializer.ts`

Responsibility:

- Convert OpenAI Chat SSE and JSON shapes in both directions.
- Preserve role/content/tool_calls/reasoning/usage semantics as stream projection only.

Forbidden:

- Deep provider policy, retry, health, route, or tool governance decisions.
- Hidden conversion from invalid tool semantics into valid tool truth.

Migration target:

- Rust plan for parsing/aggregation where behavior is semantic; TS stream IO shell.

### `sse.anthropic_gemini_stream_projection`

Owner:

- `sharedmodule/llmswitch-core/src/sse/json-to-sse/anthropic-json-to-sse-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/gemini-json-to-sse-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/gemini-sse-to-json-converter.ts`
- corresponding serializers/types.

Responsibility:

- Protocol-specific SSE projection for Anthropic Messages and Gemini Chat.

Forbidden:

- Provider runtime policy.
- Hub-generic payload repair.
- Provider-specific branches outside protocol-specific owners.

Migration target:

- Rust plan after Responses/Chat closeout.

## 6. Pipeline Boundary

SSE must be treated as an edge projection and stream materialization layer, not a Hub semantic owner.

Allowed adjacent positions:

- Request stream input to `HubReqInbound02Standardized` materialization.
- Provider stream raw input to `ProviderRespInbound01Raw` / `HubRespInbound02Parsed` materialization.
- `HubRespOutbound04ClientSemantic` to `ServerRespOutbound05ClientFrame` stream projection.

Forbidden positions:

- It must not own `HubReqChatProcess03Governed`.
- It must not own `HubRespChatProcess03Governed`.
- It must not own `VrRoute04SelectedTarget`.
- It must not own provider retry/reroute/health/quota policy.
- It must not read metadata as normal payload truth.

## 7. Required Gate Work

Add map entries in:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`

Add source anchors:

- `// feature_id: sse.codec_registry_surface`
- `// feature_id: sse.stream_parse_boundary`
- `// feature_id: sse.responses_decode_projection`
- `// feature_id: sse.responses_encode_projection`
- `// feature_id: sse.chat_stream_projection`
- `// feature_id: sse.anthropic_gemini_stream_projection`

Canonical query anchors used by the first-stage map:

- `sse.codec_registry_surface`: `createChatCodec`, `createResponsesCodec`
- `sse.stream_parse_boundary`: `assembleSseEvent`, `parseSseEvent`, `createSseParser`
- `sse.responses_decode_projection`: `materializeFinalResponse`
- `sse.responses_encode_projection`: `ResponsesJsonToSseConverter`
- `sse.chat_stream_projection`: `ChatJsonToSseConverter`
- `sse.anthropic_gemini_stream_projection`: `createAnthropicSequencer`, `createGeminiSequencer`

Add or extend architecture gates:

- `verify:sse-architecture-boundary`
  - Fails on fallback serializer paths in SSE owners.
  - Fails on `SseStreamLike = any` and `SseStreamInput = any` unless explicitly replaced by a typed stream alias.
  - Fails on new provider-specific string branches in registry/shared owners.
  - Fails on metadata keys emitted to SSE frame payloads.
  - Fails on resurrected retired SSE wrappers already listed in `hub-pipeline-stage-residue-audit.spec.ts`.
- Wire `verify:sse-architecture-boundary` into `verify:architecture-ci`.
- Keep `verify:function-map-compile-gate` wired into build.

## 8. Test Matrix

Minimum focused tests for initial closeout:

- Existing architecture gate:
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-ci`
- Existing SSE behavior tests:
  - `tests/sharedmodule/chat-sse-usage-roundtrip.spec.ts`
  - `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`
  - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
  - `tests/sharedmodule/sse-stream-mode-native.spec.ts`
  - `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`
  - `tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
- Existing Rust parser/stream-effect tests:
  - `cargo test -p router-hotpath-napi provider_sse --lib -- --nocapture`

Runtime smoke for completion claims:

- `/v1/responses` stream request through local RouteCodex.
- Evidence must include client-visible SSE terminal event and no `metadata` leak in frames.
- If provider-side upstream SSE decode is touched, include one upstream streaming provider decode smoke or captured SSE replay.

## 9. Implementation Phases

### Phase 0: Baseline

- Run current function-map compile gate.
- Run a focused SSE Jest subset.
- Capture current failures if any; do not hide them.

### Phase 1: Ownership Mapping

- Add the six function-map features above.
- Add verification-map entries.
- Add source anchors.
- Add this plan as the referenced design document.
- Run `verify:function-map-compile-gate`.

### Phase 2: Boundary Gate

- Add `scripts/architecture/verify-sse-architecture-boundary.mjs`.
- Add `npm run verify:sse-architecture-boundary`.
- Wire it into `verify:architecture-ci`.
- Initial gate should block new fallback and obvious ownership drift without forcing immediate full Rust migration.

### Phase 3: Type Surface Cleanup

- Replace `SseStreamLike = any` / `SseStreamInput = any` with explicit stream-like aliases.
- Keep payloads as `unknown` only at public boundary; immediately parse into protocol-specific types or fail.
- Move public type aliases to smallest required surface.
- No behavior change.

### Phase 4: Responses Path Semantics

- Remove fallback serialization in `shared/writer.ts` after writing red test.
- Move Responses event sequencing and terminal-event decisions behind Rust plan functions, leaving TS to perform stream IO.
- Preserve current known compatible terminal behavior only if explicitly represented in Rust contract and tested.

### Phase 5: Chat / Anthropic / Gemini Follow-through

- Repeat the same pattern for Chat, then Anthropic/Gemini.
- Keep protocol-specific differences in protocol-specific owners.
- Do not move provider-specific quirks into shared registry or Hub pipeline owners.

## 10. Risks

- SSE conversion is live runtime. A large rewrite can break streaming clients even if JSON tests pass.
- Responses terminal event behavior is subtle; `response.completed` and `response.done` are not equivalent for all clients.
- Provider-compatible upstreams may omit some OpenAI events; accepting this must be explicit contract, not fallback.
- Current tests heavily mock converter creation in HTTP handler tests; architecture closeout needs at least one real converter path test.
- Metadata leakage risk is high because SSE frames serialize nested payloads.

## 11. Definition Of Done

The SSE closeout is complete when:

- SSE features are queryable in function-map and verification-map.
- Every SSE source owner has `feature_id` anchors.
- `verify:function-map-compile-gate` passes.
- `verify:sse-architecture-boundary` exists and is wired into `verify:architecture-ci`.
- Existing focused SSE tests pass.
- No new fallback serializer, provider-specific shared branch, metadata frame leak, or retired SSE wrapper appears.
- For any runtime behavior claim, at least one real local streaming smoke proves client-visible SSE terminal behavior.
