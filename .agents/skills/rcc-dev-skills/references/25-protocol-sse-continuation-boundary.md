# 25 Protocol / SSE / Continuation Boundary

## When To Use

- `/v1/responses` continuation save/restore, direct/relay, submit_tool_outputs, or scope materialize.
- JSON/SSE parity, handler-response-sse, responses-sse-bridge, response outbound, or request inbound changes.
- Any bug where request/response history, tool calls, tool outputs, stopless guidance, or servertool state is lost between turns.

## Core Rule

Continuation is only the `/v1/responses` protocol save/restore boundary, and its owner is Chat Process.

It is not a history transformer, response repair layer, request converter, stopless hook owner, tool-governance owner, or SSE transport owner.

Fixed placement:

```text
response chat process exit
  -> save canonical continuation truth
  -> immutable store interval
  -> restore canonical continuation truth
  -> request chat process entry
```

Between save and restore, no layer may convert, clean, patch, reorder, sanitize, collapse, or infer request/response history. If history is changed there, the next turn can lose tool context or replay poisoned shape.

## Hard Lock: Immutable Interval

This is the highest-priority rule for continuation bugs:

- The only legal save point is **response Chat Process exit** after response-side tool harvest / stopless / servertool / semantic finalization.
- The only legal restore point is **next request Chat Process entry** before request-side tool governance / hook restore / provider-facing request semantics.
- The interval between those two points is immutable. It may carry bytes, ids, frames, and control metadata, but it must not interpret or rewrite semantic content.
- `req_inbound` and `resp_outbound` are normalization/projection boundaries only. They do not own continuation logic.
- SSE and server handlers are transport only. They do not own continuation logic.
- Adapter/context/converter helpers may pass already-finalized values to the next owner, but may not rebuild context from stored response/request material.

Forbidden in the immutable interval:

- semantic conversion between protocols
- context restore or history materialization
- `function_call` / `tool_call` / `function_call_output` repair, reorder, collapse, or id rewrite
- `required_action` inference or terminal-state judgment
- stopless/servertool guidance injection
- request rebuild from `entryOriginRequest`, `capturedChatRequest`, `requestSemantics`, response body, or session-only scope
- payload cleanup/sanitize done to make a later stage pass

If any of those operations appears outside Chat Process save/restore, treat it as an owner violation. Delete that logic and move the required behavior back to the Chat Process owner.

## What Must Not Change

- `req_inbound` must not restore history, patch tool results, inject stopless/servertool guidance, or rebuild continuation payload.
- `resp_outbound` must not save continuation, repair required_action, rewrite tool calls, clean history, or prepare next-turn request data.
- `handler-response-sse.ts` and `responses-sse-bridge.ts` must not inspect or decide `required_action`, terminal state, stopless schema, continuation owner, tool injection, or history repair.
- Continuation store save/restore must not mutate stored response/request content to make later stages pass.
- Handler/bridge code must not use session/conversation-only scope as continuation evidence.
- Control semantics must not be written into request/response payload/history.
- Provider response converters, adapter context builders, and server helper surfaces must not use `entryOriginRequest`, `capturedChatRequest`, `requestSemantics`, or response body content to restore continuation context after Chat Process save.

## What May Change

- `req_inbound` may perform non-destructive protocol entry normalization only: endpoint capture, request id, raw evidence capture, syntax/shape preservation, and scope binding.
- `resp_outbound` may perform client protocol projection and frame/body handoff only for already-finalized semantic response truth.
- SSE transport may write frames, keepalive comments, timeouts, closeout, and already-finalized JSON-to-SSE framing.
- Chat Process request side may restore current-turn context, apply tool governance, stopless/servertool request hooks, and provider-facing request semantics after continuation restore.
- Chat Process response side may perform tool harvest, stopless/schema judgment, servertool projection, and semantic response finalization before continuation save.
- MetadataCenter may carry control state such as continuation owner, route/control pins, protocol owner, stream intent, request truth ids, and release status.

## If Normalization Is Wrong

Normalization bugs belong to the nearest canonical semantic owner, not transport:

- Provider raw SSE/body parsing error: fix `ProviderRespInbound01Raw -> HubRespInbound02Parsed` Rust owner.
- Client-visible JSON/SSE projection mismatch: fix Rust response projection owner before server frame writing.
- Request entry shape capture error: fix req_inbound/native capture owner.
- Route/control carrier mismatch: fix MetadataCenter/runtime-control owner, not payload/history.
- Tool/history governance error: fix Chat Process request/response governance owner.

Do not fix normalization by adding a second parser or patcher in handler, bridge, SSE, resp_outbound, or continuation store.

## If Conversion Is Wrong

Conversion bugs must be fixed where the adjacent semantic conversion is owned:

- Entry protocol request -> Hub request: `ReqInbound`.
- Hub governed request -> provider semantic/wire: `ReqOutbound` / provider runtime codec.
- Provider raw response -> Hub parsed response: `RespInbound`.
- Hub governed response -> client semantic body/SSE: `RespOutbound` Rust projection.
- Continuation save/restore: only stores/restores canonical truth; it does not convert content.

If the conversion requires business judgment, it belongs in Chat Process, not inbound/outbound, SSE, or handler code.

## MetadataCenter Rule

Control plane goes to MetadataCenter. Data plane stays in request/response/store truth.

Request protocol data stays data-plane. HTTP headers, request body protocol fields, `metadata`, `client_metadata`, and `x-*` / `x-codex-*` client fields are not RouteCodex control signals by default and must not be moved into MetadataCenter. They may be parsed only by the owning protocol/request stage, and they must not be used to rebuild RouteCodex control state.

Allowed in MetadataCenter:

- continuation owner and legal scope keys
- request truth ids, port/group scope
- runtime control such as provider protocol, route hint, retry/provider pin, stream intent
- release/closeout status

Forbidden in MetadataCenter:

- full payload
- response body
- request context
- normalized input
- tool history mirror
- provider/client body snapshots
- "for later convenience" copies of data-plane objects

## Review Checklist

- Is the change before save, inside immutable store interval, or after restore?
- Does it mutate request/response history between save and restore? If yes, reject.
- Is the file a transport/handler/SSE/outbound surface? If yes, it cannot own business semantics.
- Is the state control-plane or data-plane? Control goes MetadataCenter; data goes canonical request/response/store truth.
- Is the bug normalization or conversion? Fix the owning adjacent node, not the symptom layer.
- Does the test lock client/provider observable behavior without making SSE or handler the semantic owner?

## Anti-Patterns

- "SSE frame lacks required_action, so patch handler-response-sse."
- "Next request lost tools, so restore them in req_inbound."
- "Saved response is inconvenient, so clean it during store save."
- "routeHint/providerKey is needed later, so put it into payload/history."
- "Session has a recent response, so auto-continue without explicit current request evidence."
- "Adapter has entryOriginRequest/requestSemantics, so use it to reconstruct next-turn context."
- "Outbound sees required_action/tool_calls, so classify or repair continuation before sending."
- "Inbound sees previous_response_id/sessionId, so materialize history before Chat Process."

## Minimum Verification

- Function map owner/gate still passes: `npm run verify:function-map-compile-gate`.
- Mainline docs still parse/sync when changed: `npm run verify:architecture-review-surface-light`.
- Focused request/response continuation tests for the affected edge.
- For runtime-impacting changes, rebuild/install and replay a real `/v1/responses` sample before claiming live closure.

## Remote Locator Pre-Module Boundary

- An isolated remote-continuation contract/store codec may land before live Hub wiring, but it remains a source-only pre-module.
- The locator must bind the exact entry protocol and endpoint, `continuationOwner=direct`, session, conversation, port, routing group, provider, model, auth handle, capability revision, commit time, and expiry.
- Locator fields become immutable after construction. Commit must reject invalid expiry and duplicate remote response IDs; load must reject every owner/scope/pin mismatch, expiry, and provider unavailability without cross-provider reselection or local-owner fallback.
- The locator codec must deny unknown fields so `local_context`, `history`, `tool_state`, or equivalent local Chat Process truth cannot be silently persisted or restored.
- Keep the remote-binding resource `binding_pending` until Resp04 commit, Req03 load/classification, and pinned Target execution edges are actually wired and verified. Passing isolated store/codec tests does not prove usable continuation runtime.
