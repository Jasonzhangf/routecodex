# Servertool Rust-only Architecture

## Status and scope

This is the current RouteCodex V3 design for ordinary registered servertools,
`web_search`, and client-exec tool projection. Rust owns servertool semantics;
the client owns execution of the projected command. `apply_patch` remains a
native/freeform client tool.

Stopless, `reasoningStop`, `stop_message_auto`, stop-schema injection,
stop-response interception, loop state, and server-side reentry are retired.
They are not compatibility paths and must not be reintroduced under a new
name. The official Stop hook, timer hooks, and future memory hooks belong to
the independent `codex-hooks` daemon/CodexApp framework.

## Active topology

```text
client request
  -> Server / HTTP framing
  -> V3HubReqContinuation03Classified
  -> V3HubReqChatProcess04Governed
  -> registered servertool request hook (when applicable)
  -> V3HubReqExecution05Planned
  -> provider transport
  -> V3ProviderRespInbound01Raw
  -> V3HubRespChatProcess03Governed
  -> registered servertool response hook (when applicable)
  -> V3HubRespContinuation04Committed
  -> normal client semantic/frame projection
```

For a client-exec tool, the response hook projects one ordinary
`exec_command` call. Codex executes the public CLI and returns one ordinary
tool result on the next request. That result then follows the normal request
path; RouteCodex does not perform server-side reentry, create a second kernel,
or create a servertool-specific response exit.

## Ownership and boundaries

- `routecodex-v3-server` owns listener, HTTP/WebSocket framing, body limits,
  and client disconnects; it does not decide servertool semantics.
- `routecodex-v3-runtime` owns the fixed Hub lifecycle and registered hook
  invocation at Req04/Resp03.
- `servertool-core` owns typed registered-tool contracts and client-exec
  projection plans; it does not own client transport or provider wire data.
- `routecodex-v3-sse` owns SSE framing, backpressure, and closeout only. It
  does not parse or project servertool control.
- provider codecs and transports preserve normal payload meaning and do not
  infer servertool state from metadata, logs, snapshots, or payload fields.
- the CLI validates the registered tool name and JSON object input, then emits
  one JSON projection descriptor. Codex executes the projected command through
  the normal tool loop; the CLI itself does not execute the business operation.

Control state, continuation scope, provider/auth/routing state, debug state,
and client/provider business payloads remain separate typed resources. Missing
or contradictory control truth fails explicitly; no fallback or guessed
repair is allowed.

## Hook placement

Request-side hooks run only at the mapped Req04 Chat Process governance point.
Response tool-call hooks run only at the mapped Resp03 Chat Process governance
point. Direct kernels may call only their mapped direct hooks. Hook placement
is closed and statically checked by the resource/function/mainline and
verification maps.

## Configuration and CLI contract

Configuration compiles a closed registered-tool set into the V3 manifest.
Runtime does not scan arbitrary plugin directories or dynamically discover
tools. The ordinary projection command is:

```text
routecodex servertool run <toolName> --input-json '<json-object>'
```

Input is an object containing only registered business fields. Output is one
JSON object and must not contain internal carriers, provider credentials,
routing facts, or hidden tickets. The original tool call id is preserved by
the response projection and the normal tool-result pairing is validated at
the next request governance point.

## Verification

Acceptance requires:

- Rust-only owner and module-boundary checks;
- fixed Req04/Resp03 hook placement checks;
- positive and negative registered-tool governance tests;
- controlled JSON/SSE replay through the normal response exit;
- admission snapshot lockstep and the current V3 architecture gates.

The independent hooks framework has its own daemon, CLI, MCP status, install
script, CodexApp input transport, and lifecycle tests. It is not a RouteCodex
servertool implementation and is intentionally excluded from this topology.
