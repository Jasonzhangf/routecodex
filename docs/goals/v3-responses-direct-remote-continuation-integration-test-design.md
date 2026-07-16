# V3 Responses Direct Remote Continuation Integration Test Design

## Lifecycle

~~~text
turn 1 Responses request
  -> Virtual Router once
  -> V3HubReqTarget06Resolved routed target
  -> provider function_call response
  -> V3HubRespContinuation04Committed remote locator
  -> immutable locator interval
turn 2 function_call_output + previous_response_id
  -> V3HubReqContinuation03Classified direct remote locator
  -> V3HubReqTarget06Resolved exact provider/model/auth pin
  -> same provider terminal response
  -> release locator
~~~

Req03 performs only owner/entry/scope/expiry/capability classification. Req06 alone resolves and
validates the exact provider/model/auth pin. A remote turn never enters Relay/local materialization,
Virtual Router, or target-local reselection.

## Scope truth

Every locator binds endpoint, direct owner, session, conversation, listener port, routing group,
provider, canonical model, auth alias, capability revision, commit time, and expiry. Missing or
conflicting truth is an Error01-06 failure. Provider/auth/control truth is side-channel only.

## State matrix

| State | Expected action |
| --- | --- |
| pending function call | Resp04 commits immutable remote locator |
| still running with pending tool | keep locator; do not project terminal success |
| terminal success | release matching locator after client semantic projection is determined |
| terminal failure | Error01-06; release only the matching locator |
| already terminal continuation | reject before provider send |
| missing/expired/scope mismatch/owner mismatch | reject at Req03 |
| pin/capability/provider availability mismatch | reject at Req06 |
| duplicate commit | fail at Resp04; never overwrite |
| streaming \`response.created\` only | forward as client SSE; do not commit a locator |
| streaming function/custom tool call on HTTP-only provider | fail explicitly at Resp04 capability gate |

## Positive gates

- JSON and SSE controlled upstream: function_call -> Resp04 commit -> function_call_output with
  previous_response_id -> Req03 load -> Req06 exact pin -> terminal success.
- SSE first-frame streaming: `response.created` / `status=in_progress` is only a response ID
  candidate; Resp04 commits only after an actual function/custom tool call or explicit
  `requires_action` payload. Terminal SSE with no tool call leaves no locator.
- First turn contains one Virtual Router hit; continuation turn contains zero Router nodes and no
  target-local reselection.
- Provider request preserves previous_response_id and tool output while excluding provider/auth,
  route, locator, Debug, and continuation-control fields.

## Negative gates

- chat/messages entry, Relay owner, missing locator, duplicate commit;
- endpoint/session/conversation/port/group mismatch;
- provider/model/auth/capability mismatch, expiry, unavailable provider;
- still-running, already-terminal, and terminal provider failure;
- HTTP-only streaming terminal response must not fail just because `response.created` is
  `in_progress`; HTTP-only streaming tool-call response must fail before exposing a continuable
  success because the selected provider lacks `remote_continuation`;
- Error01-06 polarity and provider/client normal-payload isolation.

## Red baseline

Before implementation, H4 store/codec tests pass while `v3.continuation.remote_binding` remains
`binding_pending`, the Direct kernel has no Resp04 commit/Req03 load/Req06 pin symbols, and two
independent turns each hit Virtual Router. That exact mismatch is the required red evidence.

## Required verification

- focused Rust state/contract tests and JSON/SSE controlled replay;
- remote integration source verifier plus positive/negative mutation fixtures;
- P6 freeze/equivalence and Error01-06 regression;
- architecture/resource/module/Rust-only/fmt/clippy/workspace gates;
- current 5555 same-entry two-turn request replay without configuration, credential, or ownership
  mutation.

## Completion boundary

Completion requires real Resp04/Req03/Req06 source bindings and both controlled and current-5555
two-turn evidence. Unit-only or store-only evidence is insufficient.

## Transport-bound continuation matrix（2026-07-15）

| Case | Required evidence |
| --- | --- |
| model declares remote continuation on HTTP-only provider | Config compile rejects before Runtime |
| WebSocket transport without endpoint | Config compile rejects missing endpoint |
| HTTP transport with WebSocket endpoint | Config compile rejects contradictory declaration |
| WebSocket handshake rejection | typed Provider transport error enters Error01-06; no HTTP retry |
| WebSocket auth rejection | typed provider/auth failure; secret absent from debug/error/client payload |
| first-turn request correlation | exactly one `response.create`; response ID binds the selected provider/model/auth/transport |
| continuation correlation | same connection and exact pin; request carries only new input and `previous_response_id` |
| split text/binary frames | incremental parser preserves event boundaries and UTF-8; malformed frame fails explicitly |
| terminal JSON success | terminal `response.completed.response` becomes the JSON provider response truth |
| terminal SSE success | server events preserve order and become equivalent Responses SSE frames plus one `[DONE]` |
| provider `error` event | Error01-06; never projected as completed response |
| cancellation/client disconnect | socket operation stops and returns health-neutral client disconnect truth |
| concurrent create on one socket | rejected or serialized; never two in-flight responses on one connection |
| still-running replacement | Resp04 atomically replaces only matching locator after a successful terminal event boundary |
| terminal success/failure | releases only the matching locator; already-terminal reuse is rejected |
| side-channel isolation | endpoint/pin/auth/socket/correlation/control fields never enter provider body or client payload |

## HTTP-only live negative evidence

The current managed provider accepts the first HTTP `/responses` turn but rejects the exact second
turn with HTTP 400 stating that `previous_response_id` is supported only on Responses WebSocket v2.
The same result occurs with `store=true` and `store=false`. This is the required negative sample for
the transport-bound Config gate and proves that successful first-turn HTTP availability is not
evidence of remote-continuation availability.

## WebSocket controlled replay requirements

- Controlled upstream must inspect the actual Authorization header and exact `response.create`
  payload; expected fixture truth must not be passed into the transport implementation.
- JSON and SSE two-turn tests must use one connection-local state owner and prove first turn Router=1,
  continuation Router=0, Req03 load=1, Req06 pin=1.
- Tests must pair success/failure/non-terminal/already-terminal cases and include handshake failure,
  auth failure, protocol error, provider error, cancellation, split frames, terminal release, and
  payload isolation.
- A source gate must reject HTTP retry, protocol fallback, Relay/local materialization, Server-owned
  socket state, and any second Runtime kernel or response exit.
- SSE transport must return the first projected WebSocket event before the provider emits the
  terminal event. A controlled upstream holds response.completed behind a test signal; transport
  send and the first stream poll must complete before that signal. Full-stream Vec accumulation,
  collect-to-Vec, or stream reconstruction from accumulated frames is forbidden.
- `live_5555_pending` can change only after current managed 5555 completes both real JSON and SSE
  two-turn continuation with the exact provider/model/auth/transport pin.

## V2 TOML Config Projection Gates（2026-07-16）

- Positive: V2 root + provider `config.v2.toml` with `[provider.responses] transport = "websocket_v2"`
  and `websocket_v2_url` publishes V3 `responses.transport = websocket_v2`, preserves the endpoint, and
  carries `remote_continuation` + `tool_outputs` model capabilities into manifest truth.
- Negative: V2 provider with `remote_continuation` + `tool_outputs` but no WebSocket v2 transport fails at
  Config compile with the same HTTP-only capability error as native V3 config.
- Negative: V2 provider with `transport = "websocket_v2"` but no endpoint fails at Config compile before
  Runtime/Provider send.
- Gate: `npm run test:v3-config-v2-compat-5555` must include the 5555 route contract plus these V2
  transport-bound cases; live config mutation remains out of scope unless explicitly authorized.
