# Responses Relay Continuation Writer Uniqueness Test Design

## 1. Objective

Lock `responses.continuation.mainline/rct-06` so relay continuation canonical save has one semantic writer:

```text
HubRespChatProcess03Governed
  -> Rust publishResponsesRecordPlanJson
  -> Rust emits ordered record_response -> finalize_retention store effects
  -> TS passes the ordered effects unchanged to conversation-store IO
  -> ChatProcRespContinuation07CanonicalSaved
```

`responses-handler.ts`, SSE transport, resp_outbound, and `responses-request-bridge.ts` must not decide whether to save, derive finish reason, rebuild request/provider/route truth, capture response-side request context, or call the relay response-store facade after pipeline completion.

Direct continuation is a separate owner family. This slice preserves the existing direct runtime path and does not treat it as relay evidence; the following direct-owner slice must move its persist/clear/capture/finalize decision into a Rust closed effect plan.

## 2. Lifecycle Contract

| State | Owner | Required output | Forbidden behavior |
| --- | --- | --- | --- |
| response governed | Rust `HubRespChatProcess03Governed` | finalized response truth | handler/SSE repair or tool-call inference |
| request context captured | request Chat Process entry / request executor host IO | current provider request id plus canonical request snapshot exists before provider response | response handler recaptures request context from post-pipeline fallback data |
| canonical save plan | Rust `publishResponsesRecordPlanJson` | ordered `record_response` then `finalize_retention` effects | TS defaulting, filtering, reordering, scope/provider/route reconstruction |
| store IO | `provider-response-effects.ts` plus conversation-store host | exact Rust effect list passed to store | second handler/bridge save path or TS effect reconstruction |
| immutable interval | continuation store transport | retained canonical truth | history/context/tool reconstruction |
| next restore | Rust request Chat Process owner | canonical restored request | session-only or cross-owner resume |

## 3. Whitebox Coverage

Positive:

1. Rust record plan uses the current active provider request id before stale request truth.
2. Rust record plan emits fixed relay owner, Responses entry kind, scope allowance, optional scope/provider/route fields, and the required `record_response -> finalize_retention` order.
3. TS provider-response effect passes the complete ordered effect list unchanged to conversation-store IO.

Negative:

1. malformed runtime-state write fails in Rust rather than becoming null/no-op in TS.
2. non-Responses endpoint or missing legal scope emits an empty relay store-effect list.
3. handler and request bridge cannot import/call/define post-pipeline relay save helpers.
4. removing the Rust canonical writer makes the architecture gate fail.
5. store record without the earlier request Chat Process capture fails with `RESPONSES_STORE_MISSING_REQUEST_CONTEXT`; handler fallback capture must not hide the error.

## 4. Module Blackbox Coverage

1. A relay `/v1/responses` response uses the request context captured before provider invocation, reaches the provider-response effect executor, records once, then finalizes once in Rust-planned order.
2. A completed/no-tool response follows the Rust retention decision and is not reclassified by the handler.
3. A direct-owned response is not routed through the relay response effect.
4. Handler completion sends the already-finalized pipeline result without route/provider/request fallback assembly.

## 5. Project Blackbox Impact

Required later in the authorized live phase:

1. relay success with pending tool call;
2. relay completed/no-tool response;
3. submit-tool-outputs continuation round trip;
4. direct response remains same-protocol and isolated from relay;
5. provider/client samples contain no continuation owner, provider pin, scope, MetadataCenter, or debug carrier leakage.

## 6. Architecture Red Gate

`verify:responses-relay-continuation-writer-uniqueness` must fail when any of these return:

- `responses-handler.ts` imports/calls `finalizeResponsesPipelineResultForHttp` or directly records a Responses response;
- `responses-request-bridge.ts` defines `finalizeResponsesPipelineResultForHttp`, `seedResponsesToolCallResponseForHttp`, `recordResponsesResponseForHttp`, or imports `recordResponsesResponseForRequest` / `deriveFinishReason` for response-side save;
- the Rust-owned provider-response effect no longer passes `plan.continuationStoreEffects` directly to store IO;
- function/resource/mainline/verification maps omit the unique-writer contract or continue listing deleted handler/bridge builders;
- package architecture wiring omits the verifier or its red fixtures.

## 7. Minimum Verification Stack

1. current-source verifier confirmed red before implementation;
2. verifier red fixtures pass;
3. focused Rust record-plan positive/negative tests;
4. provider-response effect Jest tests;
5. affected Responses handler/bridge Jest tests after stale mocks are removed;
6. `verify:responses-history-protocol-contract`;
7. resource/function/mainline/wiki/manifest gates;
8. native build and base build;
9. authorized live replay only after local gates pass.

## 8. Known Gaps After This Slice

- router-direct continuation lifecycle remains a separate Rust-effect closeout slice;
- request-side continuation action/context orchestration remains in `responses-request-bridge.ts` until the next §11.16 slice;
- provider-response ErrorErr/body/SSE and Rust engine multi-truth/fallback remain open.
