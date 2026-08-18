# V3 Responses Session Admission And SSE Keepalive Test Design

## Objective

Prevent a second `/v1/responses` request from the same listener and explicit
session/conversation scope from entering Runtime while the first response body
is still live, and restore V2-equivalent HTTP SSE keepalive comments without
changing Responses payload semantics.

## Lifecycle

```text
HTTP POST /v1/responses
  -> listener-local body capture
  -> explicit session/conversation scope extraction
  -> V3Server03HttpRequestRaw admission block
     -> conflict: Error01-06 -> standard Responses JSON/SSE error
     -> admitted: Runtime/Provider mainline
  -> V3ServerRespOutbound06ClientFrame
  -> response body EOF / stream error / body drop
  -> permit release
```

```text
finalized Direct/Relay client SSE stream
  -> immediate `: keepalive\n\n`
  -> provider/client event bytes unchanged
  -> idle 3000ms -> `: keepalive\n\n`
  -> terminal/error/drop -> stop timer and release
```

## Unique Owners

- Session admission: `routecodex-v3-server`, listener-local state and HTTP
  response-body lifetime.
- Conflict projection: `routecodex-v3-error` HTTP boundary Error01-06 chain.
- Keepalive encoding: existing
  `routecodex-v3-sse::build_v3_sse_transport_out_04_keepalive_comment`.
- Keepalive scheduling: `routecodex-v3-server` HTTP SSE body transport wrapper.
- Keepalive interval truth: `routecodex-v3-config` validates environment input
  once and publishes a positive value through `V3ServerManifest`.

Virtual Router, provider action gate, continuation stores, Provider Runtime,
Anthropic/OpenAI codecs, Chat Process, and SSE payload codecs are forbidden
owners.

## Whitebox Tests

1. Same listener, endpoint, and explicit session conflicts while active.
2. Same listener and explicit conversation conflicts while active.
3. Different sessions on one listener are admitted concurrently.
4. Same session on different listener gate instances is admitted concurrently.
5. Missing explicit session/conversation does not invent a cross-request key.
6. Permit drop removes the exact active scope.
7. Already released permits cannot release another request.
8. Conflict projects HTTP 409 with `request_in_flight` through Error01-06.
9. JSON conflict uses the standard error object.
10. Streaming conflict uses one `event: error` Responses SSE event and ends.

## Module Blackbox Tests

1. Hold the first controlled upstream response body open.
2. Send a second request with the same `client_metadata.session_id/thread_id`.
3. Assert the second response is immediate 409 and the upstream capture count
   remains one.
4. Send a different-session request while the first is open and assert a second
   upstream capture occurs.
5. Start two listeners from one aggregate, use the same scope on both, and
   assert both upstream requests are admitted.
6. Consume the first body to EOF, retry the original scope, and assert admission.
7. Drop the first client body before EOF, retry the scope, and assert admission.

## SSE Transport Tests

1. Direct and Relay successful SSE bodies emit `: keepalive\n\n` first.
2. An idle controlled stream emits another comment at the configured test
   interval.
3. Provider/client event chunks remain byte-for-byte ordered after comments are
   removed.
4. EOF stops comments.
5. Provider stream error stops comments and preserves the typed error.
6. Client drop stops comments and releases session admission.
7. Error06 SSE responses retain `event: error` as the first frame; keepalive is
   only added to successful streaming responses.
8. No comment is encoded as `event: keepalive` or a Responses JSON event.
9. An absent canonical environment input uses 3000 ms; empty, malformed, zero,
   and non-UTF-8 values fail before listener startup. The retired
   `RCC_HTTP_SSE_KEEPALIVE_MS` variable is rejected instead of acting as a
   fallback or second truth.

## Project Blackbox

After source gates:

1. Build and globally install the current V3 source.
2. Restart the aggregate exactly once with the managed `restart` command.
3. Verify all aggregate member `/health` endpoints and installed binary identity.
4. Send a managed 5555 same-session overlap pair while the first SSE body is
   active.
5. Verify the second request returns standard `request_in_flight`, no second
   provider request is recorded, and no malformed tool-output/empty-role error
   appears.
6. Send a different-session control concurrently and verify it reaches Runtime.
7. Verify raw SSE starts with a keepalive comment and later completes normally.

## Known Gaps And Non-Goals

- This does not repair malformed client history in a codec.
- This does not queue or retry a rejected request.
- This does not use provider action gate as request admission.
- This does not change continuation ownership or save/restore semantics.
- Requests without an explicit stable session/conversation scope remain
  request-local and are not cross-request locked.
