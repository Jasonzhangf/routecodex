# V3 Servertool Center Skeleton

## Scope

This contract defines the fixed RouteCodex V3 servertool governance skeleton
for ordinary servertools and registered `web_search` projections. Stopless,
`reasoningStop`, `stop_message_auto`, and stop-response interception are
retired; no Stopless branch belongs in this center.

## Invariants

1. RouteCodex control logic is owned by the MetadataCenter/servertool hook
   boundary, never by SSE framing or provider payload code.
2. Registered servertools use the same request/response Chat Process and
   normal continuation/client projection boundaries as other tools.
3. Direct and Relay paths use the same registered hook semantics where the
   protocol contract permits it; they do not create a second response exit.
4. Scope is explicit and includes entry/endpoint, port, routing group,
   session, conversation, and tool identity where applicable.
5. Internal state and provider/client business payloads are physically
   separate. Missing or contradictory control truth fails explicitly.

## Fixed graph

```text
request:
  V3HubReqContinuation03Classified
    -> V3HubReqChatProcess04Governed
    -> ServertoolReq01ToolIdentified
    -> ServertoolReq02StateLoaded
    -> ServertoolReq03HookApplied
    -> V3HubReqExecution05Planned

response:
  V3ProviderRespInbound01Raw
    -> V3HubRespChatProcess03Governed
    -> ServertoolResp01ToolInspected
    -> ServertoolResp02StateTransitioned
    -> ServertoolResp03Projected
    -> V3HubRespContinuation04Committed
```

`web_search` and ordinary servertool CLI projection are registered tool
behaviors in this graph. `apply_patch` remains native/freeform client
tooling. The official Stop hook and future timer/memory hooks are independent
`codex-hooks` features and communicate through CodexApp, not this graph.

## Three stages

1. `identify_tool` reads the normalized request/response shape and matches
   only a registered tool.
2. `load + state transition` uses the typed scope and the MetadataCenter
   state owner; it never infers state from logs or payload metadata.
3. `hook projection` performs the registered business projection and returns
   to the normal Hub path. There is no servertool-specific response wrapper,
   prompt injection, reentry, or fallback.

## Hook placement

- Request hooks run only at the fixed Req04 governance point.
- Response tool-call hooks run only at the fixed Resp03 governance point.
- Direct hooks may be called only by the mapped Direct kernel boundary.
- SSE remains transport-only: framing, backpressure, and closeout only.
- A hook error is explicit and observable; an unavailable independent hooks
  sidecar is degraded state and must not prevent RouteCodex startup.

## Configuration and acceptance

Configuration compiles a closed registered-tool set into the manifest; runtime
does not discover arbitrary tools. Acceptance requires the current
resource/function/mainline bindings, fixed-hook placement checks, positive
and negative governance tests, and controlled JSON/SSE replay through the
normal response exit.
