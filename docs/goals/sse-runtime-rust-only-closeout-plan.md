# SSE Runtime Rust-Only Closeout Plan

Created: 2026-07-03

## Goal And Acceptance Criteria

Goal: close RouteCodex SSE runtime as Rust-only for Hub Pipeline. TypeScript must not own or wrap Hub runtime SSE encode/decode/parse/dispatch semantics. TS may keep only one public library surface for external callers, and that public surface must be forbidden from Hub Pipeline runtime imports.

Acceptance criteria:

- Hub Pipeline runtime does not import `sharedmodule/llmswitch-core/src/sse/**`.
- Hub Pipeline runtime calls Rust/NAPI SSE runtime entrypoints directly through `sharedmodule/llmswitch-core/src/native/router-hotpath/**`.
- Rust owns protocol dispatch, JSON->SSE frame generation, SSE->JSON decode/materialization, event type validation, parser strictness, terminal detection, usage handling, reasoning/tool/function_call projection, and fail-fast error semantics.
- TS public SSE lib, if kept, is a public convenience library only. It may marshal input/output to unified native entrypoints but must not be used by Hub Pipeline, provider-response, server handlers, Virtual Router, or provider runtimes.
- Old TS SSE runtime directories are physically deleted after callers/tests/gates are migrated. Do not leave unused wrapper files.
- Architecture gates enforce no runtime imports from `src/sse/**`, no restored registry/parser/converter/sequencer/event-generator runtime owners, no fallback/salvage/synthetic SSE semantics.
- Focused Rust, TS, architecture, build, and live/replay verification passes before declaring closeout.

## Scope And Boundaries

In scope:

- `sharedmodule/llmswitch-core/src/sse/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/**sse**.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**sse**.rs`
- Hub Pipeline SSE callers under `sharedmodule/llmswitch-core/src/conversion/hub/**`
- Server/runtime callsites that currently reach TS SSE registry/converters
- SSE function-map, verification-map, mainline-call-map, wiki/manifest, and architecture gates
- SSE tests under `tests/sharedmodule/**`, `sharedmodule/llmswitch-core/tests/**`, `tests/server/**`, and related architecture scripts

Out of scope:

- Provider routing/health/retry policy.
- Servertool/stopless behavior except proving SSE does not own it.
- Responses continuation save/restore except proving SSE does not mutate it outside Chat Process.
- Broad provider protocol redesign beyond adjacent SSE encode/decode contracts.

## Design Principles

- Rust is the only runtime semantic truth for SSE.
- TypeScript Hub runtime may do IO and native marshaling only from the native bridge layer, not from `src/sse/**`.
- No fallback, no implicit protocol recovery, no unknown-protocol default, no salvage into success truth.
- Delete dead TS runtime modules physically after migration. Do not keep wrappers "just in case".
- Keep public TS lib small and isolated. Its existence must not justify runtime TS wrappers.
- Tests must be moved to runtime/native/public-lib-appropriate entrypoints instead of importing deleted TS converter classes.
- Update maps/gates before claiming ownership changes closed.

## Target Architecture

Runtime path:

```text
HubRespOutbound04ClientSemantic
  -> native SSE runtime bridge
  -> Rust build_sse_frames_from_json_json(protocol, response, request_id, model, config)
  -> ServerRespOutbound05ClientFrame

ProviderRespInbound01Raw
  -> native SSE runtime bridge
  -> Rust build_json_from_sse_json(protocol, body_text, request_id, model, config)
  -> HubRespInbound02Parsed
```

Forbidden runtime path:

```text
Hub Pipeline
  -> sharedmodule/llmswitch-core/src/sse/index.ts
  -> registry / converter / parser / sequencer TS
  -> native helper
```

Public TS library path:

```text
external caller
  -> sharedmodule/llmswitch-core/src/sse/index.ts
  -> unified native SSE runtime bridge
  -> Rust
```

## Technical Plan

### 1. Add unified Rust/NAPI SSE runtime entrypoints

Create or extend Rust modules under `router-hotpath-napi/src` with unified dispatch:

- `build_sse_frames_from_json_json(input_json: String) -> Result<String>`
- `build_json_from_sse_json(input_json: String) -> Result<String>`
- Optional parser entrypoints if existing names remain authoritative:
  - `parse_sse_event_with_config_json`
  - `parse_sse_stream_with_config_json`
  - `parse_sse_stream_chunk_with_config_json`

The unified input must carry explicit protocol:

```json
{
  "protocol": "openai-chat | openai-responses | anthropic-messages | gemini-chat",
  "direction": "json_to_sse | sse_to_json",
  "response": {},
  "body_text": "",
  "request_id": "",
  "model": "",
  "config": {}
}
```

Rust must parse protocol into an enum and fail fast on unknown protocol. Do not default to chat/responses.

Reuse existing Rust owners where possible:

- `chat_sse_event_payload.rs`
- `responses_sse_event_payload.rs`
- `anthropic_sse_event_payload.rs`
- `gemini_sse_event_payload.rs`
- `hub_resp_inbound_sse_stream_sniffer.rs`
- `hub_resp_inbound_format_parse.rs`

### 2. Add one native TS bridge for runtime

Add a single native bridge file such as:

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.ts`

Allowed responsibilities:

- JSON stringify/parse for native calls.
- Validate native returned JSON is structurally usable.
- Throw native errors explicitly.

Forbidden responsibilities:

- Protocol dispatch in TS.
- Event sequencing in TS.
- SSE parse semantics in TS.
- Response status/terminal/usage/tool/reasoning synthesis in TS.

### 3. Move Hub Pipeline callsites to native bridge

Replace runtime imports of `src/sse/**` with direct native bridge calls.

Known callsite categories:

- Hub response outbound JSON->SSE projection.
- Provider response inbound SSE->JSON materialization.
- Any provider-response path currently using `defaultSseCodecRegistry`.
- Any test/runtime mock expecting `sse/registry/sse-codec-registry.js`.

Runtime code must import only from `sharedmodule/llmswitch-core/src/native/router-hotpath/**` for SSE runtime behavior.

### 4. Redefine architecture ownership

Update:

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/mainline-call-graph.md`
- Generated manifests if required by existing gates

Ownership changes:

- Replace `sse.codec_registry_surface` as runtime registry owner with a Rust runtime dispatch owner, or mark it public-only if still needed.
- Replace `sse.stream_parse_boundary` owner with Rust parser owner.
- Keep `sse.event_type_validation` owner in Rust.
- Add or refine `sse.public_ts_lib_surface` only if keeping public TS lib.

Gate expectations:

- Function map must not require `src/sse/registry/sse-codec-registry.ts` or `src/sse/sse-to-json/parsers/sse-parser.ts` as runtime owners.
- Runtime forbidden paths must include Hub Pipeline, provider-response, server handler, provider runtime, and Virtual Router importing `src/sse/**`.
- Public lib feature must be explicitly forbidden from Hub runtime paths.

### 5. Delete old TS runtime SSE modules

After callsites/tests/maps move, physically delete runtime TS SSE modules:

- `sharedmodule/llmswitch-core/src/sse/registry/**`
- `sharedmodule/llmswitch-core/src/sse/json-to-sse/**`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/**`
- `sharedmodule/llmswitch-core/src/sse/shared/**`

Allowed to keep:

- `sharedmodule/llmswitch-core/src/sse/index.ts` as public lib only
- `sharedmodule/llmswitch-core/src/sse/types.ts` or equivalent public type file only
- Documentation if updated to describe Rust-only runtime truth

If keeping `src/sse/types/**`, confirm they are public type definitions only and do not encode runtime semantic decisions.

### 6. Rewrite tests by entrypoint

Runtime tests must target Hub/native runtime, not TS converter classes:

- JSON response -> native frames -> client-visible SSE bytes.
- Provider raw SSE body -> native JSON materialization -> Hub parsed response.
- Unknown protocol fails fast.
- Malformed/incomplete stream fails fast.
- No internal metadata leaks.
- Tool/function_call/reasoning/usage aggregation stays exact.

Public lib tests, if kept, should only prove:

- Public functions forward to native unified entrypoints.
- Unknown protocol fails fast.
- No fallback protocol selection.
- Public lib is not imported by runtime paths.

Delete or rewrite tests that import:

- `create*Sequencer`
- `*JsonToSseConverter`
- `*SseToJsonConverter`
- `defaultSseCodecRegistry`
- `sse-to-json/parsers/sse-parser`

### 7. Update architecture gates

Update `scripts/architecture/verify-sse-architecture-boundary.mjs` and related gates so they:

- Do not require deleted TS registry/parser/converter files.
- Fail if Hub runtime imports `sharedmodule/llmswitch-core/src/sse/**`.
- Fail if deleted TS runtime files return.
- Fail if TS contains protocol dispatch, fallback, salvage, synthetic terminal, or parser semantic markers outside Rust/native bridge.
- Require unified native SSE runtime exports.
- Require public TS lib, if present, to call only native unified entrypoints.

## Risk And Mitigation

- Risk: deleting TS converters breaks tests that were testing implementation rather than contract.
  Mitigation: rewrite tests to native/runtime entrypoints before deletion.

- Risk: unified Rust dispatch accidentally becomes a fallback dispatcher.
  Mitigation: explicit protocol enum and reverse tests for unknown/mismatched protocol.

- Risk: public TS lib is re-used by Hub runtime later.
  Mitigation: architecture gate forbids runtime imports from `src/sse/**`.

- Risk: function-map/mainline docs drift.
  Mitigation: update map/wiki/manifest in the same changeset and run map gates.

- Risk: old sequencer/parser code returns later.
  Mitigation: add deleted-path/content denylist markers in architecture gates.

## Verification Matrix

Rust:

- `cargo test -p router-hotpath-napi sse --lib -- --nocapture`
- Focused tests for unified encode/decode dispatch, unknown protocol, malformed stream, terminal detection, tool/function_call aggregation, reasoning/usage handling.

Native build:

- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`

Focused Jest:

- Runtime/native SSE parity tests after rewrite.
- Public lib tests if public lib remains.
- Provider-response SSE materialization tests.
- Hub response outbound SSE projection tests.

Architecture gates:

- `npm run verify:sse-architecture-boundary`
- `npm run verify:responses-sse-business-module`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-review-surface-light`
- Any manifest sync gates required by mainline changes.

Type/build:

- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `npx tsc -p tsconfig.json --noEmit --pretty false`
- `npm run build:base`
- `git diff --check`

Live/replay:

- Replay at least one real or fixture sample for:
  - OpenAI Chat JSON->SSE
  - Responses JSON->SSE
  - Responses provider SSE->JSON
  - Anthropic JSON->SSE and SSE->JSON if available
  - Gemini JSON->SSE and SSE->JSON if available
- If no live sample exists for a protocol, document the exact missing evidence and run native fixture replay instead. Do not claim live closure for that protocol.

## Implementation Steps

1. Record current failing state: `verify:sse-architecture-boundary` failure and current TS SSE runtime imports.
2. Add Rust unified SSE runtime dispatch entrypoints and unit tests.
3. Add `native-sse-runtime.ts` bridge with no TS protocol semantics.
4. Move Hub/provider-response runtime callsites from `src/sse/**` to the native bridge.
5. Rewrite focused tests to native/runtime entrypoints.
6. Update function-map, verification-map, mainline-call-map, wiki, and manifests.
7. Update architecture gates to Rust-only runtime rules.
8. Delete TS runtime SSE directories and stale tests.
9. Keep or replace `src/sse/index.ts` as public lib only; add gate forbidding runtime import.
10. Run full verification matrix.
11. Commit only relevant verified files. Do not stage unrelated dirty docs or user changes.
12. Append final evidence to `note.md`; promote durable verified conclusion to `MEMORY.md` only if fully verified.

## Definition Of Done

- No Hub Pipeline/runtime import from `sharedmodule/llmswitch-core/src/sse/**`.
- Old TS SSE runtime directories are physically deleted or reduced to public-only files.
- Unified Rust/NAPI SSE runtime dispatch exists and is the only runtime path.
- Architecture gates enforce Rust-only runtime ownership and deleted TS runtime non-resurrection.
- All required focused tests, architecture gates, TypeScript builds, native build, and `build:base` pass.
- Live/replay evidence is recorded for available protocols.
- Final report clearly lists changed ownership, validation evidence, remaining gaps if any, and commit hash.
