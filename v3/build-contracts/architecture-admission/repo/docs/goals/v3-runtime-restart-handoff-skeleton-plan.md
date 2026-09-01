# V3 Runtime Restart Handoff Skeleton

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
provider-attempt handoff. Both Direct and Relay use this skeleton; only their
protocol codecs and semantic projectors differ.

One persistent HTTP/1.1 connection may carry multiple sequential requests.
Connection identity is stable, but closeout phase and the registered protocol
terminal are request-scoped: accepting the next request must atomically clear
the previous response-started phase and closeout frame. A restart before the
new response headers therefore emits the generic HTTP 503 terminal; it must
never inherit a completed Chat/Responses SSE phase from the preceding request.

Every lease is keyed by `request_id`, `pipeline_id`, `server_id`, `port`,
`session_scope`, and `generation`. A restart exports a typed checkpoint through
the lifecycle control plane. The checkpoint contains remaining deadlines,
frame counters, semantic commit, and closeout state. Restore must subtract the
time spent outside the process and allocate a new generation. It must not infer
identity from payload, logs, or session alone.

## Error contract

Provider transport and response-shape failures enter Error01 through Error05
before Error06 can close the client response. RouteCodex request-stage internal
failures project as 598; response-stage internal failures project as 599;
external provider HTTP identity remains external. No provider retry, switch,
decode failure, malformed terminal, or illegal EOF may directly close the
client stream or become a silent EOF. If aggregate exec replacement interrupts
an accepted request before response headers, the Front owner must emit one
explicit HTTP 503 terminal with `server_restart_in_progress`; an unstarted
request and an already-started response must not receive that pre-header frame.

## Required gates

- red/green tests for admission, Direct, Relay, SSE framing and semantic trees;
- duplicate/out-of-order frames, terminal exactly once, timeout, disconnect and
  scope mismatch tests;
- checkpoint export/restore tests proving generation and deadline monotonicity;
- provider A/B/C evidence using one request id and raw request, provider-bound
  request, raw response, and client projection;
- `cargo check --locked`, affected crate tests, workspace/build gates;
- canonical global install and `routecodex restart`, then `/health` on 7777,
  4444 and 10000;
- live Direct JSON/SSE, Relay Responses/Chat/Anthropic, provider malformed SSE,
  provider 502/503, transport timeout, disconnect, and restart replay;
- DSH Review only after all preceding evidence is current.

## Current implementation boundary

The typed Front lease and lifecycle checkpoint file are implemented in
`routecodex-v3-server` and `routecodex-v3-lifecycle`. The remaining work is to
bind the lease to the actual HTTP client socket and provider transport broker,
cover all entry protocols and continuation paths, and prove cross-exec
reattach online. A checkpoint file alone is not evidence that an existing
client socket has been reattached.
