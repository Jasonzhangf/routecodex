# Request Payload Copy Budget

## Scope

`feature_id: request.payload_copy_budget` owns only request-scoped payload ownership and materialization timing. It does not own provider wire shape, client response shape, routing semantics, tool governance, or payload trimming.

## Copy Classes

1. Boundary serialization: Node object -> JSON string -> Rust `serde_json::Value` -> JSON string -> Node object. This is unavoidable while N-API contracts accept and return JSON strings.
2. Ownership materialization: copies created to preserve retry/reentry semantics. These must be lazy and request-scoped.
3. Stage normalization: Rust transformations that need an owned mutable payload. These should move ownership forward instead of holding raw and normalized full payloads at the same time.
4. Observability/debug snapshots: allowed only as side-channel evidence and never as provider/client payload truth.

## Current Contract

- `prepareRequestPayloadRetrySeed()` returns a borrowed seed for object payloads and performs no eager `JSON.stringify()` or `structuredClone()`.
- `restoreRequestPayloadFromRetrySeed()` materializes a clone only when retry/reentry restore is actually requested.
- If clone materialization fails, restore returns explicit `undefined`; it must not JSON serialize/parse the seed or shallow-spread a snapshot as compensation.
- `capture_req_inbound_responses_context_snapshot()` moves `raw_request` into the normalized request owner after borrowing it once for tool-output capture.
- Responses context capture and standardization call `convert_bridge_input_to_chat_messages_borrowed()`, borrowing `input` and `tools` owners instead of cloning complete bridge arrays merely to derive chat messages.
- Hub engine takes `HubPipelineOutput.payload` and `metadata` after normalize, so normalized payload ownership moves forward instead of cloning out of the native output object.
- `coerce_standardized_request_from_owned_parts()` lets Hub engine pass payload and normalized metadata directly, avoiding the temporary wrapper object and its payload clone.
- Hub engine removes `standardizedRequest` and `rawPayload` from the standardizer output object before downstream use, so the temporary result object does not retain another full payload copy.
- Route selection moves `target`, `decision`, and diagnostics out of the route result. Typed request nodes consume owned decision/provider payload values instead of cloning their complete object trees.
- Request outbound context merge borrows the format payload and Responses snapshot while deriving tool-output/tool patches. It does not clone either complete value merely to call the merge planner.
- `runHubPipeline()` strips top-level `body` from the object sent to `executeHubPipelineNative()` and passes the current Hub request only as `payload`. Rust `HubPipelineRequest` consumes `payload`, so keeping both fields serialized the same body twice without semantic value.
- `buildHubPipelineMetadata()` shallow-copies request metadata and removes `__raw_request_body` only from the Rust-bound projection. The source metadata retains the same raw-entry object reference for RequestExecutor Responses conversation capture and client-response restoration.
- The request payload remains semantically equivalent. No field may be trimmed, summarized, or omitted to reduce memory.

## Forbidden Paths

- Do not copy request payload into `MetadataCenter`, provider runtime state, or client response projection.
- Do not serialize `metadata.__raw_request_body` into Rust Hub metadata or use it as an alternate provider payload. It may remain request-scoped source evidence only for the existing Responses capture and client restoration contracts.
- Do not change provider configuration or `config.toml` to avoid large payloads.
- Do not special-case `additional_tools`; first define its protocol semantics before using its smaller current output size as evidence.

## Future Work

- Replace JSON-string N-API calls with a Rust-owned request handle or streaming/binary transfer if true zero-copy across the JS/Rust boundary becomes a release goal.
- Add live high-concurrency measurement after build/install/restart to quantify RSS/residency reduction on real GPT-5.6-sized requests.

## Required Gates

- `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/retry-payload-snapshot.spec.ts --runInBand`
- `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/request-executor.spec.ts --runInBand -t "retry seeds without eager duplicate snapshots"`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi request_payload_copy_budget --lib -- --nocapture`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand -t "responses request context capture must borrow bridge input/tools"`
- `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts --runInBand`
- `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts --runInBand`
- `npm run jest:run -- --runTestsByPath tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts --runInBand -t "responses"`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
