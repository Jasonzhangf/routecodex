# Responses Second-Candidate Stream Incomplete Plan

> Owner: Jason
> Date: 2026-06-14
> Status: open
> Trigger sample: `openai-responses-router-gpt-5.4-20260614T142012141-342968-546`

## 1. Problem

After the first provider failed with `UPSTREAM_HEADERS_TIMEOUT`, router-direct correctly switched to the second candidate:

```text
provider-switch ... switch=exclude_and_reroute ... -> cc.key1.gpt-5.4-mini.gpt-5.5
```

The second candidate then produced a Responses SSE stream that closed before `response.completed` / `response.done`. The client received:

```text
event: error
code=upstream_stream_incomplete
message=stream closed before response.completed
```

Usage/session logs recorded `finish_reason=unknown`.

## 2. Scope

This is not the same failure class as provider `send` throwing before a response exists. It is a post-send stream contract failure:

- provider send succeeded enough to return a stream;
- handler/SSE projection observed missing terminal Responses event;
- error is projected from response streaming code, not from `router-direct.onProviderError`.

## 3. Current Gap

The current direct-path error reroute plan locks provider-send failures and candidate exhaustion. It does not yet lock:

- second-candidate stream ending without terminal event;
- whether `upstream_stream_incomplete` should re-enter provider failure policy or remain client-projected;
- finish reason normalization for incomplete direct Responses streams;
- live behavior that prevents `finish_reason=unknown` from being treated as success.

## 4. Candidate Owners

- `src/server/handlers/handler-response-sse.ts`: live SSE terminal watch and client error frame emission.
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`: `buildResponsesStreamIncompleteErrorPayloadForHttp` / terminal repair planning.
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`: SSE-facing facade.
- Rust owner target: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_response_utils.rs` if terminal repair / projection policy moves native.

## 5. Required Design Decision

Decide whether `upstream_stream_incomplete` is:

1. a provider execution failure that must enter ErrorErr01-05 and reroute if another candidate remains; or
2. a terminal response projection error after all candidate execution has already committed to the client SSE stream.

The decision must be explicit. Do not silently convert incomplete SSE into success, and do not locally retry after client frames have already been emitted unless the protocol can prove no client-visible semantic was committed.

## 6. Minimum Tests

- Forward: second candidate closes before `response.completed` and no client-success terminal is emitted.
- Reverse: complete Responses SSE (`response.completed` + `response.done`) must not emit `upstream_stream_incomplete`.
- Reverse: client disconnect during SSE remains `CLIENT_DISCONNECTED`, not provider failure.
- Reverse: already-started client SSE cannot be rerouted after semantic frames have been emitted unless a protocol-safe restart plan exists.

## 7. Verification

- `pnpm exec jest tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`
- A new focused SSE incomplete regression spec under `tests/server/handlers/`
- Live `/v1/responses` SSE replay proving either completed terminal frames or explicit non-success error accounting.

## 8. Completion Signal

- `upstream_stream_incomplete` has a single owner and documented ErrorErr stage.
- `finish_reason=unknown` is not logged as successful completion for incomplete Responses SSE.
- Live replay of the 5520-style sample has concrete evidence.
