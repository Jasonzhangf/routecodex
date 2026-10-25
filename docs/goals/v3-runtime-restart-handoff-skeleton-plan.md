# V3 Runtime Restart Handoff Skeleton

This plan follows `routecodex-managed-restart-live-continuity` v2. A managed
restart switches generations immediately. Lossless transfer of every in-flight
socket, TLS state, future or response is no longer a delivery requirement.
Affected clients detect interruption and decide whether to retry; RCC must not
resend the request or fabricate completion to hide the interruption.
An old response that can still use its valid original binding and connection
must not be rejected only because the generation changed. Closed connections
are not promised recovery.

## Contract

The V3 proxy owns two independent lifecycles: the client Front connection and
the provider Transport attempt. A Runtime Child may execute request/response
work, but it must not own the client socket or choose the client output
protocol. The request-stage typed execution plan is the only source for
Direct/Relay and client protocol projection; response parsing never selects an
output path from provider response shape.

The fixed semantic chain is:

```text
ReqInbound -> ReqChatProcess -> VR/MetadataCenter plan -> ReqOutbound
-> Provider Transport -> RespInbound -> RespChatProcess -> RespOutbound
```

SSE framing, protocol semantic trees, provider materialization, and client
projection are separate adjacent stages. Provider raw SSE, provider errors,
routing, health, retry, generation, checkpoint, and debug state are side
channels and must never enter normal client or provider payloads.

The retired `toolreason` text-fence syntax is outside the current protocol and
outside this goal's runtime, compatibility, and acceptance surface. Current
tests and live evidence must use typed native JSON/SSE events and structured
tool-call/tool-result objects.

## Front contract

The Front owns the accepted client connection, keepalive, client frame
sequence, absolute/idle deadlines, and exactly-once client closeout. The
Transport Broker owns provider transport identity, provider frame sequence, and
provider-attempt lifetime. Both Direct and Relay use this skeleton; only their
protocol codecs and semantic projectors differ.

One persistent HTTP/1.1 connection may carry multiple sequential requests.
Connection identity is stable, but response-started phase and closeout control
are request-scoped: accepting the next request must atomically clear the
previous response phase. A restart before the new response headers terminates
the transport without an HTTP response or error bytes. It must never inherit
a completed Chat/Responses SSE phase from the preceding request.

Keep the typed request, listener, session and generation bindings needed for
request-local cancellation and closeout. Do not reconstruct them from payload,
logs or session alone. Checkpoint metadata does not prove a socket or provider
attempt survived restart and is not a prerequisite for switching generations.
Any retained recovery path must preserve send uncertainty; it cannot infer
`NotSent` or replay permission from missing data.

## Error contract

Provider transport and response-shape failures enter the typed Error chain.
Request-stage 598, response-stage 599 and external provider status describe
internal causes only. They never authorize a client error status or payload.
Recovery remains internal while an eligible candidate exists. On exhaustion
or exec replacement, the Front terminates transport without an HTTP error,
JSON envelope, protocol error event or fabricated successful terminal. A
response whose headers have started remains observably incomplete; it must
not receive a second response or inherit another request's framing state.

## Required gates

- red/green tests for admission, Direct, Relay, SSE framing and semantic trees;
- duplicate/out-of-order frames, terminal exactly once, timeout, disconnect and
  scope mismatch tests;
- request-scoped generation, cancellation and detectable restart interruption;
- provider A/B/C evidence using one request id and raw request, provider-bound
  request, raw response, and client projection;
- `cargo check --locked`, affected crate tests, workspace/build gates;
- canonical install and one formal `rccv3 restart`, then health checks on the
  actual configured listeners;
- live Direct JSON/SSE, Relay Responses/Chat/Anthropic, provider malformed SSE,
  provider 502/503, transport timeout, disconnect, and restart replay;
- one independent milestone review through the actual host workflow after
  applicable author acceptance; reuse unchanged valid evidence.

## Current implementation boundary

The earlier checkpoint/lease implementation is historical source evidence.
The lifecycle owner must classify retained callers under the current restart
contract before removing code. Current acceptance proves immediate managed
restart, detectable interruption, request-local closeout and subsequent
requests through the real entry. Cross-exec reattachment is not a remaining
delivery prerequisite. This document correction does not claim a code change
or a completed runtime acceptance.
