# OpenAI Request Filter Payload Copy Budget Test Design

## Lifecycle

1. The OpenAI-to-OpenAI request codec parses the N-API JSON argument into one owned `serde_json::Value`.
2. Tool-call arguments normalize in place.
3. The shared request filter consumes that owned value, removes RouteCodex-only top-level fields, and sanitizes messages/tool calls in place.
4. The codec serializes the final provider wire payload once for the existing N-API return contract.

## Owner And Resource

- `feature_id`: `conversion.openai_request_filter_payload_copy_budget`.
- Resource: `protocol.openai_chat_request_filter_projection`.
- Mainline topology: internal provider-wire codec block; no new numbered pipeline node or Stage A edge.
- Owner files: `openai_openai_codec.rs` and `shared_chat_request_filters.rs`.

## White-Box Positive

- The owned filter preserves all protocol fields except the existing explicit removal set.
- `preserveStreamField=true` keeps `stream:false`; false removes only false stream.
- Assistant tool calls lose `call_id` and `tool_call_id`; tool messages map `call_id` to `tool_call_id` and remove legacy `id/call_id`.
- Non-object input remains semantically unchanged.

## White-Box Negative

- `run_openai_openai_request_codec_json` must not serialize a temporary `{payload,preserveStreamField}` wrapper and parse the filter result back.
- The production filter path must not clone the complete payload object or complete messages array before mutation.
- The external `pruneChatRequestPayloadJson` N-API contract must remain available as a single parse, owned transform, and single serialize wrapper.

## Module Black-Box

- Existing shared filter Rust tests remain green.
- A direct-native OpenAI request codec sample proves provider wire semantics after rebuilding native.

## Required Gates

- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi shared_chat_request_filters --lib -- --nocapture`
- `npm run build:native-hotpath`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/openai-request-filter-payload-copy-budget.spec.ts --runInBand`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- Target `rustfmt --check` and `git diff --check`.

## Project Black-Box

- Hub request, VR selection, provider configuration, retry, continuation, MetadataCenter, and response semantics remain unchanged.
- This is an ownership/materialization change only; no live payload field is trimmed beyond the established filter contract.

## Known Gap

- The outer JS/Rust JSON-string boundary remains unavoidable under the current N-API contract. RSS claims require the parent goal's authorized concurrent live replay.
