# Hub Pipeline Engine Fail-Fast Closeout Test Design

## Scope

This design covers `docs/goals/hubpipeline-full-rust-closeout-plan.md` section 11.16 item 5 only.

Target behavior:

- request identity is required and never replaced by a fixed synthetic string;
- client/provider protocol truth is written once by typed ingress/runtime owners and is not inferred from endpoint or flat metadata;
- provider exclusions use one route/error control carrier and are not mirrored between flat metadata and MetadataCenter;
- stopless activation reads one MetadataCenter runtime-control family;
- required terminal stopless output must contain `chatResponse`;
- system clock failure is explicit and never persisted as timestamp `0`.

Out of scope:

- provider-specific behavior;
- payload trimming;
- release/global install/restart/live replay without explicit authorization;
- stopless prompt/schema behavior owned by the active stopless claims;
- request payload ownership work owned by `feature_id:request.payload_copy_budget`.

## Current Source Evidence

The following current behaviors are known red targets:

| Contract | Current source residue | Required correction |
| --- | --- | --- |
| request identity | `hub_pipeline_lib/engine.rs` substitutes `hub_pipeline_rust_lib_request` for blank `requestId` | fail with a stable Rust error code before stage execution |
| client protocol | `resolve_request_entry_protocol` derives protocol from `entryEndpoint` | consume typed ingress protocol only |
| provider protocol | engine and `napi_bindings.rs` accept request field, flat metadata, MetadataCenter, or endpoint-derived protocol | consume the owning typed request/runtime-control source for the current direction |
| route exclusions | engine copies flat `metadata.excludedProviderKeys` into both router input and MetadataCenter snapshot; `router_metadata_input.rs` rereads flat metadata | consume one route/error exclusion carrier only |
| stopless activation | engine recursively reads MetadataCenter, requestTruth, flat metadata, `__rt`, and nested snapshots | consume `MetadataCenter.runtimeControl.stopless` only |
| terminal response | terminal stopless handling falls through `handlerResult.chatResponse -> runtimeOutput.chatResponse -> original chatprocess payload` | require the canonical terminal `handlerResult.chatResponse` and fail otherwise |
| state timestamp | `current_timestamp_ms()` maps system-time failure to `0` | return/propagate an explicit error and perform no write |

## Resource And Owner Preconditions

Existing bindings:

- `request.protocol_context` owns entry protocol truth at `ServerReqInbound01ClientRaw`.
- `metadata.runtime_control` owns request-route `providerProtocol` at `MetaReq04RuntimeControlBound`.
- `metadata.request_truth` owns `requestId` and request identity.
- `stopless.runtime_snapshot` and `metadata.runtime_control` own stopless control state.

Resolved map prerequisite:

- `route.retry_exclusion_set` is the ErrorErr05-owned request-local side-channel;
- ErrorErr05 is its only writer; retry restore and VR selection are readers;
- flat metadata, MetadataCenter, provider wire, and client response are forbidden writers.

Parallel worker work is not a blanket blocker. Runtime edits proceed with targeted patches that preserve the existing payload-ownership and stopless diff; only a direct, non-mergeable conflict in the same semantic region stops the current item.

## Lifecycle Matrix

| Lifecycle point | Positive case | Negative case |
| --- | --- | --- |
| Hub entry | non-empty typed request identity enters diagnostics and output unchanged | blank/whitespace identity fails before NormalizeRequest; no synthetic id |
| request protocol | typed ingress client protocol is preserved through req_inbound and response projection | endpoint-only or flat-metadata-only client protocol is rejected |
| selected provider protocol | runtime-control selected provider protocol reaches req_outbound/resp_inbound | request/flat metadata disagreement cannot override runtime-control truth; missing owner truth fails |
| retry route control | one exclusion carrier reaches VR and excludes exactly the declared targets | flat metadata cannot create, replace, or duplicate exclusions |
| stopless response gate | active center slot enables stopless; absent slot leaves response unchanged | flat metadata, requestTruth, `__rt`, or nested snapshot cannot activate it |
| terminal stopless result | terminal handler result with `chatResponse` returns that payload | missing terminal `chatResponse` fails; runtime output/original payload is never substituted |
| reset state write | valid wall-clock value is written once | clock failure returns an error and emits no timestamp/write plan |

## White-Box Tests

### Request identity

Positive:

- `HubPipelineRequest.request_id="req-owned"` returns `requestId="req-owned"`.

Negative:

- empty and whitespace request ids return `hub_pipeline_missing_request_id`;
- diagnostics/effects are not produced with `hub_pipeline_rust_lib_request`;
- residue gate rejects the fixed fallback literal.

### Protocol truth

Positive:

- request-side typed ingress client protocol is consumed without endpoint inference;
- response-side `metadataCenterSnapshot.runtimeControl.providerProtocol` is consumed unchanged;
- selected req_outbound protocol remains the VR/runtime-selected protocol.

Negative:

- endpoint-only client protocol does not materialize a protocol;
- flat `metadata.clientProtocol` and `metadata.providerProtocol` do not become owner truth;
- conflicting flat metadata cannot override typed/runtime-control truth;
- missing typed/runtime protocol returns stable fail-fast errors.

### Exclusion carrier

Positive:

- the canonical route/error carrier with `["provider.a", "provider.b"]` reaches VR once and preserves order.

Negative:

- flat `metadata.excludedProviderKeys` alone is ignored or rejected at the boundary selected by the resource contract;
- MetadataCenter and flat metadata cannot both carry the set;
- malformed/non-string exclusions fail at the owning parser rather than being silently filtered;
- residue gate rejects engine clone/mirror insertion and `router_metadata_input.rs` flat reads.

### Stopless activation

Positive:

- `metadataCenterSnapshot.runtimeControl.stopless.active=true` enables the response hook.

Negative:

- the same stopless object under flat metadata, requestTruth, `__rt`, or nested `metadataCenterSnapshot` does not enable the hook;
- no center slot means no stopless interception;
- session mismatch/reset behavior remains covered by the existing stopless owner tests and is not reimplemented here.

### Terminal `chatResponse`

Positive:

- terminal execution with `handlerResult.chatResponse` returns exactly that response.

Negative:

- terminal execution missing `handlerResult.chatResponse` returns `hub_pipeline_stopless_resp_hook_terminal_missing_chat_response`;
- `runtimeOutput.chatResponse` cannot compensate;
- original `chatprocess_payload` cannot compensate;
- non-terminal projection still requires projected `chatResponse` and preserves its existing explicit error.

### State time

Positive:

- a valid `SystemTime` duration creates the expected millisecond timestamp.

Negative:

- pre-epoch/system-time error returns `hub_pipeline_state_clock_failed`;
- no reset plan or MetadataCenter write is emitted with `at=0`;
- residue gate rejects `.unwrap_or(0)` in the state clock owner.

## Module Blackbox

Use the direct native Hub Pipeline binding with representative OpenAI chat, OpenAI Responses, and Anthropic Messages fixtures.

Positive assertions:

- explicit typed identity/protocol/control inputs produce byte-equivalent provider/client semantic payloads;
- canonical exclusion control still reroutes to the next legal provider;
- canonical stopless terminal output remains unchanged.
- compiled `.node` handle-mode replay with top-level `providerProtocol="openai-responses"` and `retryExclusionSet=["openai.key1.gpt-5.5"]` selects `openai.key2.gpt-5.5`.

Negative assertions:

- remove each typed identity/protocol/control input independently and assert the exact fail-fast boundary;
- provide only legacy flat metadata and assert it cannot activate protocol/exclusion/stopless semantics;
- provide terminal stopless output without `chatResponse` and assert failure, not original-payload success.
- compiled `.node` handle-mode replay with only flat `metadata.excludedProviderKeys=["openai.key1.gpt-5.5"]` still selects `openai.key1.gpt-5.5`.

## Project Blackbox

Source/build closeout:

- focused Rust tests;
- source verifier and negative revival fixtures;
- resource/function/mainline/verification gates;
- architecture review light;
- native hotpath build;
- base build.

Runtime closeout, only after explicit authorization:

- global release install;
- one aggregate restart using a locator port;
- health/version verification on all configured member ports;
- same-entry request dry-run proving final provider request protocol and exclusion behavior;
- response dry-run or live sample proving terminal stopless response and client projection;
- canonical sample/log scan for internal control leakage.

## Required Gates

Planned focused gates:

```text
cargo test -p router-hotpath-napi hub_pipeline_engine_failfast --lib
npm run verify:hub-pipeline-engine-failfast-closeout
npm run test:hub-pipeline-engine-failfast-closeout-red-fixtures
npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/hub-pipeline-engine-failfast-direct-native.spec.ts
npm run verify:resource-operation-map
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
npm run verify:architecture-review-surface-light
npm run build:native-hotpath
ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base
git diff --check
```

## Completion Rule

Item 5 source/native/build closeout requires all positive and negative cases above, physical removal of the fallback/mirror residues, synchronized resource/function/mainline/verification bindings, and green native/base builds.

It is not runtime-complete without an authorized installed-artifact replay. The full Hub Pipeline goal remains active until item 6 and all final host/runtime closeout gates are complete.
